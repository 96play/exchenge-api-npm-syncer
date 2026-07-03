#!/usr/bin/env node

import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TARGET_REGISTRY_URL = 'https://registry.npmjs.org';
const DEFAULT_HISTORICAL_PUBLISH_TAG = 'sync';
const DEFAULT_TARGET_ACCESS = 'public';
const PUBLISH_TOKEN_ENV_NAMES = [
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'SOURCE_REGISTRY_TOKEN',
  'npm_config__auth',
  'npm_config__authToken',
  'npm_config_auth_token',
  'NPM_CONFIG__AUTH',
  'NPM_CONFIG__AUTHTOKEN',
  'NPM_CONFIG_AUTH_TOKEN'
];

export function readConfig(env = process.env) {
  const sourcePackageName = required(env.PACKAGE_NAME, 'PACKAGE_NAME');
  const targetPackageName = env.TARGET_PACKAGE_NAME || sourcePackageName;
  const config = {
    sourceRegistryUrl: required(env.SOURCE_REGISTRY_URL, 'SOURCE_REGISTRY_URL'),
    sourceRegistryToken: required(env.SOURCE_REGISTRY_TOKEN, 'SOURCE_REGISTRY_TOKEN'),
    packageName: sourcePackageName,
    sourcePackageName,
    targetPackageName,
    targetRegistryUrl: env.TARGET_REGISTRY_URL || DEFAULT_TARGET_REGISTRY_URL,
    targetRepositoryUrl: required(env.TARGET_REPOSITORY_URL, 'TARGET_REPOSITORY_URL'),
    targetAccess: env.TARGET_ACCESS || DEFAULT_TARGET_ACCESS,
    historicalPublishTag: env.HISTORICAL_PUBLISH_TAG || DEFAULT_HISTORICAL_PUBLISH_TAG,
    dryRun: parseBoolean(env.DRY_RUN ?? 'false', 'DRY_RUN')
  };

  config.sourceRegistryUrl = normalizeRegistryUrl(config.sourceRegistryUrl);
  config.targetRegistryUrl = normalizeRegistryUrl(config.targetRegistryUrl);

  if (config.historicalPublishTag === 'latest') {
    throw new Error('HISTORICAL_PUBLISH_TAG must not be "latest"; historical versions must never be published with the latest tag.');
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.historicalPublishTag)) {
    throw new Error(`HISTORICAL_PUBLISH_TAG is not a valid npm dist-tag: ${config.historicalPublishTag}`);
  }

  if (!['public', 'restricted'].includes(config.targetAccess)) {
    throw new Error('TARGET_ACCESS must be "public" or "restricted". npm uses "restricted" for private scoped packages.');
  }

  validatePackageName(config.sourcePackageName, 'PACKAGE_NAME');
  validatePackageName(config.targetPackageName, 'TARGET_PACKAGE_NAME');
  return config;
}

export async function runSync(env = process.env) {
  const config = readConfig(env);
  const result = createResult(config);
  const workRoot = await mkdtemp(path.join(tmpdir(), 'npm-registry-sync-'));

  try {
    const npmrcPath = path.join(workRoot, '.npmrc');
    await writeSourceNpmrc(npmrcPath, config.sourceRegistryUrl, config.sourceRegistryToken);
    const npmEnv = buildNpmEnv(npmrcPath, env);

    const sourceMeta = await fetchMetadataOrRecord({
      result,
      registryUrl: config.sourceRegistryUrl,
      packageName: config.sourcePackageName,
      npmEnv,
      label: 'source registry',
      missingOk: false
    });
    if (!sourceMeta) {
      return result;
    }

    const sourceDistTags = readDistTags(sourceMeta);
    const sourceVersions = Object.keys(readVersions(sourceMeta));
    result.sourceLatestVersion = sourceDistTags.latest || null;

    if (!result.sourceLatestVersion) {
      result.errors.push('Source registry does not have a latest dist-tag. Nothing was published.');
      return result;
    }

    if (!sourceVersions.includes(result.sourceLatestVersion)) {
      result.errors.push(`Source latest dist-tag points to ${result.sourceLatestVersion}, but that version is not present in source versions.`);
      return result;
    }

    const targetMeta = await fetchMetadataOrRecord({
      result,
      registryUrl: config.targetRegistryUrl,
      packageName: config.targetPackageName,
      npmEnv,
      label: 'target registry',
      missingOk: true
    });
    if (!targetMeta) {
      return result;
    }

    const targetDistTags = readDistTags(targetMeta);
    const targetVersions = Object.keys(readVersions(targetMeta));
    result.npmjsLatestVersion = targetDistTags.latest || null;

    const plan = createSyncPlan({
      sourceVersions,
      sourceLatestVersion: result.sourceLatestVersion,
      targetVersions,
      targetLatestVersion: result.npmjsLatestVersion
    });

    result.missingVersions = plan.missingVersions;
    result.plannedHistoricalVersions = plan.historicalVersions;
    result.plannedLatestVersion = plan.latestVersion;
    result.warnings.push(...plan.warnings);

    if (config.dryRun) {
      result.warnings.push('DRY_RUN=true; no pack or publish commands were executed.');
      return result;
    }

    for (const version of plan.historicalVersions) {
      try {
        const publishResult = await publishVersion({
          config,
          version,
          tag: config.historicalPublishTag,
          workRoot,
          npmEnv
        });
        if (publishResult.alreadyExists) {
          result.warnings.push(`Historical version ${version} already existed at publish time; treating it as success.`);
        } else {
          result.publishedHistoricalVersions.push(version);
        }
      } catch (error) {
        const message = error instanceof StageError
          ? `${error.stage} failed for historical version ${version}: ${error.message}`
          : `Publishing historical version ${version} failed: ${error.message}`;

        if (error instanceof StageError && error.stage === 'pack') {
          result.warnings.push(message);
        } else {
          result.errors.push(message);
        }
      }
    }

    if (plan.latestVersion) {
      try {
        const publishResult = await publishVersion({
          config,
          version: plan.latestVersion,
          tag: 'latest',
          workRoot,
          npmEnv
        });
        if (publishResult.alreadyExists) {
          result.warnings.push(`Latest version ${plan.latestVersion} already existed at publish time; treating it as success.`);
        } else {
          result.publishedLatestVersion = plan.latestVersion;
        }
      } catch (error) {
        const message = error instanceof StageError
          ? `${error.stage} failed for latest version ${plan.latestVersion}: ${error.message}`
          : `Publishing latest version ${plan.latestVersion} failed: ${error.message}`;
        result.errors.push(message);
      }
    }

    return result;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export function createSyncPlan({ sourceVersions, sourceLatestVersion, targetVersions, targetLatestVersion }) {
  const targetVersionSet = new Set(targetVersions);
  const missingVersions = [...sourceVersions]
    .filter((version) => !targetVersionSet.has(version))
    .sort(compareSemver);

  const historicalVersions = missingVersions
    .filter((version) => version !== sourceLatestVersion)
    .sort(compareSemver);

  const latestVersion = missingVersions.includes(sourceLatestVersion) ? sourceLatestVersion : null;
  const warnings = [];

  if (!latestVersion && targetVersionSet.has(sourceLatestVersion) && targetLatestVersion !== sourceLatestVersion) {
    warnings.push(
      `npmjs already has source latest version ${sourceLatestVersion}, but npmjs latest points to ${targetLatestVersion || '(none)'}. ` +
      'Trusted Publishing-only mode cannot repair the latest tag for an existing version because this tool never runs npm dist-tag add and does not use a token fallback.'
    );
  }

  return {
    missingVersions,
    historicalVersions,
    latestVersion,
    warnings
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}

export function parseSemver(version) {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

export function sourceAuthKeyForRegistry(registryUrl) {
  const url = new URL(normalizeRegistryUrl(registryUrl));
  return `//${url.host}${url.pathname}:_authToken`;
}

export function sourceAlwaysAuthKeyForRegistry(registryUrl) {
  const url = new URL(normalizeRegistryUrl(registryUrl));
  return `//${url.host}${url.pathname}:always-auth`;
}

export function encodePackageName(packageName) {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/');
    if (parts.length !== 2 || !parts[0].slice(1) || !parts[1]) {
      throw new Error(`Invalid scoped package name: ${packageName}`);
    }
    return `@${encodeURIComponent(parts[0].slice(1))}%2f${encodeURIComponent(parts[1])}`;
  }

  return encodeURIComponent(packageName);
}

export function normalizeRegistryUrl(registryUrl) {
  const url = new URL(registryUrl);
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

export function isVersionAlreadyPublished(output) {
  const text = output.toLowerCase();
  return text.includes('epublishconflict') ||
    text.includes('cannot publish over the previously published version') ||
    text.includes('cannot publish over previously published version') ||
    text.includes('you cannot publish over the previously published versions') ||
    (text.includes('cannot modify pre-existing version') && text.includes('forbidden'));
}

export function parseNpmViewMetadata(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('npm view returned an empty response.');
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm view returned metadata in an unexpected shape.');
  }

  return {
    versions: normalizeVersionsField(parsed.versions),
    'dist-tags': normalizeDistTagsField(parsed['dist-tags'] ?? parsed.distTags)
  };
}

export function buildPublishArgs(tarballPath, targetRegistryUrl, tag, targetAccess = DEFAULT_TARGET_ACCESS) {
  return [
    'publish',
    tarballPath,
    '--registry',
    targetRegistryUrl,
    '--tag',
    tag,
    '--access',
    targetAccess
  ];
}

export function formatSummary(result) {
  const lines = [
    '## npm registry sync summary',
    '',
    `- Source package name: ${result.sourcePackageName || result.packageName || '(unknown)'}`,
    `- Target package name: ${result.targetPackageName || result.packageName || '(unknown)'}`,
    `- Source latest version: ${result.sourceLatestVersion || '(none)'}`,
    `- npmjs latest version: ${result.npmjsLatestVersion || '(none)'}`,
    `- Missing versions: ${formatList(result.missingVersions)}`,
    `- Published historical versions: ${formatList(result.publishedHistoricalVersions)}`,
    `- Published latest version: ${result.publishedLatestVersion || '(none)'}`,
    `- Warnings: ${formatList(result.warnings)}`,
    `- Errors: ${formatList(result.errors)}`
  ];

  return `${lines.join('\n')}\n`;
}

async function fetchMetadataOrRecord({ result, registryUrl, packageName, npmEnv, label, missingOk }) {
  try {
    return await fetchPackageMetadata(registryUrl, packageName, npmEnv, missingOk);
  } catch (error) {
    result.errors.push(`Failed to read ${label} metadata: ${error.message}`);
    return null;
  }
}

async function fetchPackageMetadata(registryUrl, packageName, npmEnv, missingOk) {
  const result = await runCommand('npm', [
    'view',
    packageName,
    'versions',
    'dist-tags',
    '--json',
    '--registry',
    registryUrl
  ], { env: npmEnv });

  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (missingOk && isPackageNotFound(output)) {
      return { versions: {}, 'dist-tags': {} };
    }
    throw new Error(formatCommandFailure('npm view', result));
  }

  return parseNpmViewMetadata(result.stdout);
}

async function publishVersion({ config, version, tag, workRoot, npmEnv }) {
  const versionRoot = path.join(workRoot, sanitizePathSegment(`${version}-${tag}`));
  const packDir = path.join(versionRoot, 'source-pack');
  const unpackDir = path.join(versionRoot, 'unpacked');
  const outDir = path.join(versionRoot, 'repacked');
  await mkdir(packDir, { recursive: true });
  await mkdir(unpackDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const sourceTarball = await packFromSource({
    packageName: config.sourcePackageName,
    version,
    sourceRegistryUrl: config.sourceRegistryUrl,
    packDir,
    npmEnv
  });

  await runStageCommand('unpack', 'tar', ['-xzf', sourceTarball, '-C', unpackDir], { env: npmEnv });
  await rewritePackageJson({
    packageJsonPath: path.join(unpackDir, 'package', 'package.json'),
    expectedSourceName: config.sourcePackageName,
    targetPackageName: config.targetPackageName,
    expectedVersion: version,
    targetRepositoryUrl: config.targetRepositoryUrl
  });

  const repackedTarball = path.join(outDir, `${sanitizePathSegment(config.targetPackageName)}-${sanitizePathSegment(version)}.tgz`);
  await runStageCommand('repack', 'tar', ['-czf', repackedTarball, '-C', unpackDir, 'package'], { env: npmEnv });

  const publishArgs = buildPublishArgs(repackedTarball, config.targetRegistryUrl, tag, config.targetAccess);
  const publishResult = await runCommand('npm', publishArgs, { env: npmEnv });
  if (publishResult.code !== 0) {
    const output = `${publishResult.stdout}\n${publishResult.stderr}`;
    if (isVersionAlreadyPublished(output)) {
      return { alreadyExists: true };
    }
    throw new StageError('publish', formatCommandFailure('npm publish', publishResult));
  }

  return { alreadyExists: false };
}

async function packFromSource({ packageName, version, sourceRegistryUrl, packDir, npmEnv }) {
  const spec = `${packageName}@${version}`;
  const result = await runCommand('npm', [
    'pack',
    spec,
    '--registry',
    sourceRegistryUrl,
    '--pack-destination',
    packDir,
    '--json'
  ], { env: npmEnv });

  if (result.code !== 0) {
    throw new StageError('pack', formatCommandFailure('npm pack', result));
  }

  return resolvePackedTarball(result.stdout, packDir);
}

export function rewritePackageManifest({ packageJson, expectedSourceName, targetPackageName, expectedVersion, targetRepositoryUrl }) {
  if (packageJson.name !== expectedSourceName) {
    throw new StageError('rewrite package.json', `Packed package name ${packageJson.name} did not match expected source package ${expectedSourceName}.`);
  }
  if (packageJson.version !== expectedVersion) {
    throw new StageError('rewrite package.json', `Packed package version ${packageJson.version} did not match expected ${expectedVersion}.`);
  }

  const existingRepository = packageJson.repository && typeof packageJson.repository === 'object' && !Array.isArray(packageJson.repository)
    ? packageJson.repository
    : {};

  return {
    ...packageJson,
    name: targetPackageName,
    repository: {
      ...existingRepository,
      type: 'git',
      url: targetRepositoryUrl
    }
  };
}

async function rewritePackageJson({ packageJsonPath, expectedSourceName, targetPackageName, expectedVersion, targetRepositoryUrl }) {
  const raw = await readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(raw);

  const rewrittenPackageJson = rewritePackageManifest({
    packageJson,
    expectedSourceName,
    targetPackageName,
    expectedVersion,
    targetRepositoryUrl
  });

  await writeFile(packageJsonPath, `${JSON.stringify(rewrittenPackageJson, null, 2)}\n`);
}

async function resolvePackedTarball(stdout, packDir) {
  const trimmed = stdout.trim();
  const candidates = [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed[0]?.filename) {
      candidates.push(parsed[0].filename);
    }
  } catch {
    const lastLine = trimmed.split('\n').filter(Boolean).at(-1);
    if (lastLine) {
      candidates.push(lastLine);
    }
  }

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(packDir, candidate);
    if (await fileExists(absolute)) {
      return absolute;
    }

    const basenameCandidate = path.join(packDir, path.basename(candidate));
    if (await fileExists(basenameCandidate)) {
      return basenameCandidate;
    }
  }

  throw new StageError('pack', 'npm pack completed but the tarball path could not be resolved.');
}

async function runStageCommand(stage, command, args, options) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new StageError(stage, formatCommandFailure(`${command} ${args[0] || ''}`.trim(), result));
  }
  return result;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function writeSourceNpmrc(npmrcPath, sourceRegistryUrl, token) {
  const authKey = sourceAuthKeyForRegistry(sourceRegistryUrl);
  const alwaysAuthKey = sourceAlwaysAuthKeyForRegistry(sourceRegistryUrl);
  const contents = `${authKey}=${token}\n${alwaysAuthKey}=true\n`;
  await writeFile(npmrcPath, contents, { mode: 0o600 });
  await chmod(npmrcPath, 0o600);
}

function buildNpmEnv(npmrcPath, env) {
  const childEnv = {
    ...env,
    NPM_CONFIG_USERCONFIG: npmrcPath,
    npm_config_userconfig: npmrcPath
  };

  for (const name of PUBLISH_TOKEN_ENV_NAMES) {
    delete childEnv[name];
  }

  return childEnv;
}

function createResult(config) {
  return {
    packageName: config.targetPackageName,
    sourcePackageName: config.sourcePackageName,
    targetPackageName: config.targetPackageName,
    dryRun: config.dryRun,
    sourceLatestVersion: null,
    npmjsLatestVersion: null,
    missingVersions: [],
    plannedHistoricalVersions: [],
    plannedLatestVersion: null,
    publishedHistoricalVersions: [],
    publishedLatestVersion: null,
    warnings: [],
    errors: []
  };
}

function readVersions(metadata) {
  return metadata.versions && typeof metadata.versions === 'object' ? metadata.versions : {};
}

function readDistTags(metadata) {
  return metadata['dist-tags'] && typeof metadata['dist-tags'] === 'object' ? metadata['dist-tags'] : {};
}

function normalizeVersionsField(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((version) => [String(version), {}]));
  }

  if (typeof value === 'string') {
    return { [value]: {} };
  }

  if (value && typeof value === 'object') {
    return value;
  }

  return {};
}

function normalizeDistTagsField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, version]) => typeof version === 'string')
  );
}

function isPackageNotFound(output) {
  const text = output.toLowerCase();
  return text.includes('e404') ||
    text.includes('404 not found') ||
    text.includes('not in this registry');
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];

    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);

    if (aNumeric && bNumeric) {
      return Number(a) - Number(b);
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return a < b ? -1 : 1;
  }

  return 0;
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', ''].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function validatePackageName(packageName, name) {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/');
    if (parts.length !== 2 || !parts[0].slice(1) || !parts[1]) {
      throw new Error(`${name} is not a valid scoped package name: ${packageName}`);
    }
    return;
  }

  if (!packageName || packageName.includes('/')) {
    throw new Error(`${name} is not a valid package name: ${packageName}`);
  }
}

function sanitizePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatCommandFailure(label, result) {
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  const exit = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
  return details ? `${label} failed with ${exit}: ${details}` : `${label} failed with ${exit}.`;
}

function formatList(values) {
  if (!values || values.length === 0) {
    return '(none)';
  }
  return values.join(', ');
}

async function writeGitHubStepSummary(summary, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }
  await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

export class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
  }
}

if (isMainModule()) {
  let result = null;
  try {
    result = await runSync(process.env);
  } catch (error) {
    result = {
      packageName: process.env.TARGET_PACKAGE_NAME || process.env.PACKAGE_NAME || null,
      sourcePackageName: process.env.PACKAGE_NAME || null,
      targetPackageName: process.env.TARGET_PACKAGE_NAME || process.env.PACKAGE_NAME || null,
      sourceLatestVersion: null,
      npmjsLatestVersion: null,
      missingVersions: [],
      publishedHistoricalVersions: [],
      publishedLatestVersion: null,
      warnings: [],
      errors: [error.message]
    };
  }

  const summary = formatSummary(result);
  console.log(summary);
  await writeGitHubStepSummary(summary);

  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}
