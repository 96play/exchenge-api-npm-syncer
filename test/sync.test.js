import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishArgs,
  compareSemver,
  createSyncPlan,
  encodePackageName,
  isVersionAlreadyPublished,
  parseNpmViewMetadata,
  readConfig,
  rewritePackageManifest,
  sourceAuthKeyForRegistry
} from '../src/sync.js';

test('sorts npm semver values in ascending order', () => {
  const versions = [
    '1.0.0',
    '1.0.0-beta.2',
    '2026.7.2-h18',
    '1.0.0-beta.11',
    '1.0.0-alpha',
    '0.9.9',
    '1.0.0-beta'
  ];

  assert.deepEqual(versions.sort(compareSemver), [
    '0.9.9',
    '1.0.0-alpha',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0',
    '2026.7.2-h18'
  ]);
});

test('plans historical versions separately from source latest', () => {
  const plan = createSyncPlan({
    sourceVersions: ['1.0.0', '1.1.0', '1.2.0'],
    sourceLatestVersion: '1.2.0',
    targetVersions: ['1.0.0'],
    targetLatestVersion: '1.0.0'
  });

  assert.deepEqual(plan.missingVersions, ['1.1.0', '1.2.0']);
  assert.deepEqual(plan.historicalVersions, ['1.1.0']);
  assert.equal(plan.latestVersion, '1.2.0');
  assert.deepEqual(plan.warnings, []);
});

test('warns when source latest already exists but npmjs latest points elsewhere', () => {
  const plan = createSyncPlan({
    sourceVersions: ['1.0.0', '1.1.0'],
    sourceLatestVersion: '1.1.0',
    targetVersions: ['1.0.0', '1.1.0'],
    targetLatestVersion: '1.0.0'
  });

  assert.deepEqual(plan.missingVersions, []);
  assert.equal(plan.latestVersion, null);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /cannot repair the latest tag/);
  assert.match(plan.warnings[0], /npm dist-tag add/);
});

test('registry auth key keeps the registry path', () => {
  assert.equal(
    sourceAuthKeyForRegistry('https://registry.example.com/repository/npm-private'),
    '//registry.example.com/repository/npm-private/:_authToken'
  );
});

test('encodes scoped package names for registry metadata URLs', () => {
  assert.equal(encodePackageName('@scope/pkg'), '@scope%2fpkg');
  assert.equal(encodePackageName('plain-package'), 'plain-package');
});

test('configuration defaults are applied and latest is rejected as historical tag', () => {
  const env = {
    SOURCE_REGISTRY_URL: 'https://registry.example.com/npm',
    SOURCE_REGISTRY_TOKEN: 'secret',
    PACKAGE_NAME: '@scope/pkg',
    TARGET_REPOSITORY_URL: 'https://github.com/acme/pkg.git'
  };

  assert.equal(readConfig(env).targetRegistryUrl, 'https://registry.npmjs.org/');
  assert.equal(readConfig(env).historicalPublishTag, 'sync');
  assert.equal(readConfig(env).targetAccess, 'public');
  assert.equal(readConfig(env).sourcePackageName, '@scope/pkg');
  assert.equal(readConfig(env).targetPackageName, '@scope/pkg');

  assert.throws(
    () => readConfig({ ...env, HISTORICAL_PUBLISH_TAG: 'latest' }),
    /must not be "latest"/
  );

  assert.equal(readConfig({ ...env, TARGET_ACCESS: 'restricted' }).targetAccess, 'restricted');
  assert.equal(readConfig({ ...env, TARGET_PACKAGE_NAME: '@public/pkg' }).targetPackageName, '@public/pkg');
  assert.throws(
    () => readConfig({ ...env, TARGET_ACCESS: 'private' }),
    /TARGET_ACCESS must be "public" or "restricted"/
  );
});

test('recognizes publish conflicts as idempotent success', () => {
  assert.equal(isVersionAlreadyPublished('npm ERR! code EPUBLISHCONFLICT'), true);
  assert.equal(isVersionAlreadyPublished('You cannot publish over the previously published versions.'), true);
  assert.equal(isVersionAlreadyPublished('npm ERR! code E403 Forbidden - user is not allowed'), false);
});

test('parses npm view versions and dist-tags output', () => {
  const metadata = parseNpmViewMetadata(JSON.stringify({
    versions: ['1.0.0', '1.1.0'],
    'dist-tags': {
      latest: '1.1.0',
      beta: '2.0.0-beta.1'
    }
  }));

  assert.deepEqual(Object.keys(metadata.versions), ['1.0.0', '1.1.0']);
  assert.deepEqual(metadata['dist-tags'], {
    latest: '1.1.0',
    beta: '2.0.0-beta.1'
  });
});

test('publish args default to public package access', () => {
  assert.deepEqual(
    buildPublishArgs('/tmp/pkg.tgz', 'https://registry.npmjs.org/', 'sync'),
    [
      'publish',
      '/tmp/pkg.tgz',
      '--registry',
      'https://registry.npmjs.org/',
      '--tag',
      'sync',
      '--access',
      'public'
    ]
  );
});

test('publish args can request restricted package access', () => {
  assert.deepEqual(
    buildPublishArgs('/tmp/pkg.tgz', 'https://registry.npmjs.org/', 'latest', 'restricted'),
    [
      'publish',
      '/tmp/pkg.tgz',
      '--registry',
      'https://registry.npmjs.org/',
      '--tag',
      'latest',
      '--access',
      'restricted'
    ]
  );
});

test('rewrites package manifest name to target package name', () => {
  const rewritten = rewritePackageManifest({
    packageJson: {
      name: '@internal/pkg',
      version: '1.2.3',
      repository: {
        directory: 'packages/pkg'
      },
      main: 'index.js'
    },
    expectedSourceName: '@internal/pkg',
    targetPackageName: '@public/pkg',
    expectedVersion: '1.2.3',
    targetRepositoryUrl: 'https://github.com/acme/pkg.git'
  });

  assert.equal(rewritten.name, '@public/pkg');
  assert.equal(rewritten.version, '1.2.3');
  assert.equal(rewritten.main, 'index.js');
  assert.deepEqual(rewritten.repository, {
    directory: 'packages/pkg',
    type: 'git',
    url: 'https://github.com/acme/pkg.git'
  });
});
