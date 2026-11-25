import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('fnos/jxc');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const parseJson = (relative) => JSON.parse(read(relative));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = Object.fromEntries(
  read('manifest')
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => line.split('=').map((part) => part.trim())),
);

assert.equal(manifest.appname, 'fn-jxc');
assert.equal(manifest.version, packageJson.version, 'package.json 与 fnOS Manifest 版本不一致');
assert.equal(manifest.platform, 'all');
assert.equal(manifest.desktop_uidir, 'ui');
assert.equal(manifest.desktop_applaunchname, 'fn-jxc.main');

const ui = parseJson('app/ui/config');
assert.equal(ui['.url']['fn-jxc.main'].port, '${APP_PORT}');
assert.equal(ui['.url']['fn-jxc.main'].url, '/');

const privilege = parseJson('config/privilege');
assert.equal(privilege.defaults['run-as'], 'package');
const resource = parseJson('config/resource');
assert.equal(resource['docker-project'].projects[0].name, manifest.appname);

for (const name of ['install', 'config', 'uninstall']) {
  assert.ok(Array.isArray(parseJson(`wizard/${name}`)));
}

const compose = read('app/docker/docker-compose.yaml');
assert.match(compose, /container_name: fn-jxc/);
assert.ok(compose.includes(`ghcr.io/boshi6498/jxc:${manifest.version}`), '镜像与 fnOS Manifest 版本不一致');
assert.match(compose, /\$\{APP_PORT\}:3001/);
assert.match(compose, /\$\{TRIM_PKGVAR\}\/data:\/app\/data/);

for (const script of [
  'main',
  'install_init',
  'install_callback',
  'config_init',
  'config_callback',
  'upgrade_init',
  'upgrade_callback',
  'uninstall_init',
  'uninstall_callback',
]) {
  assert.match(read(`cmd/${script}`), /^#!\/bin\/bash/m, `缺少 Bash shebang: ${script}`);
}

for (const icon of ['ICON.PNG', 'ICON_256.PNG', 'app/ui/images/icon_64.png', 'app/ui/images/icon_256.png']) {
  assert.ok(fs.statSync(path.join(root, icon)).size > 0, `图标为空: ${icon}`);
}

const image = `ghcr.io/boshi6498/jxc:${manifest.version}`;
if (process.env.VERIFY_GHCR === '1') {
  try {
    execFileSync('docker', ['manifest', 'inspect', image], { stdio: 'ignore' });
  } catch {
    throw new Error(`无法匿名拉取 ${image}；请先发布镜像并将 GHCR 包设为公开`);
  }
}

console.log('fnOS package structure is valid.');
