/**
 * migrate-link-profile.mjs —— 把「本地目录安装」（`link:` / `file:`）的 profile 迁到新包名。
 *
 * 为什么需要这个脚本：插件的两条自动路径都**故意**不碰本地目录安装 ——
 * 那通常是维护者在调源码，自动搬走等于把他正在改的那份代码换成 npm 上的正式包。
 * 但改名之后，profile 里的依赖键还是旧名，而目录里的 `package.json` 已经是
 * `dsh-ui-stage`，名字对不上，宿主会认为"这个 bundle 不存在"直接从启用列表里掉。
 * 所以这一步只能手工做 —— 这个脚本就是把那几步手工操作包成一条命令。
 *
 * 它做的四件事（顺序有意义）：
 *   1. **先验货**：目标目录的 `package.json` 必须已经是新包名。不是就先 `git pull`
 *      —— 否则改完 profile 指向一个还叫旧名的目录，等于把插件改坏。
 *   2. 改 profile 清单：依赖键旧名 → 新名（**spec 原样保留**，仍然是那个本地路径），
 *      `bundles` 里的旧名原地换成新名（位置不动：列表顺序即加载顺序）。
 *   3. 修 `node_modules`：删掉旧名的目录联接，给新名建一个指向同一目录的联接。
 *      这一步是"名字对得上"之外的第二半 —— 宿主是从 `node_modules/<包名>` 里读清单的。
 *   4. 回读验证：经新联接读到 `name` / `version`，对不上就如实报错。
 *
 * 安全约定：
 *   - 改之前**备份** profile 的 package.json（同目录带时间戳）；
 *   - 只动本插件那一项，别的依赖一个不碰；
 *   - 旧联接删不掉（应用正开着它）不算失败，只提示重启后再删；
 *   - `--dry-run` 只报告要做什么，不写盘。
 *
 * 用法：
 *   node tools/migrate-link-profile.mjs                 # 迁默认 profile
 *   node tools/migrate-link-profile.mjs --dry-run       # 只看要做什么
 *   node tools/migrate-link-profile.mjs --profile <dir> # 指定 profile 目录
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NEW_NAME = 'dsh-ui-stage'
const OLD_NAME = 'dsh-plugin-startup-animation'
/** 只有这些 spec 前缀算"本地目录安装" —— 与 lib/self-manage.mjs 的 isDevSpec 同一套判据。 */
const DEV_SPEC = /^(link|file|portal|workspace):/

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const dryRun = flag('--dry-run')
const homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.resolve(valueOf('--profile') || path.join(homeDir, 'profiles', 'desktop'))

const say = (text) => console.log(text)
const fail = (text) => {
  console.error(`! ${text}`)
  process.exit(1)
}

/** 从一个 spec 里解析出真实目录（`link:` / `file:` 后面那段）。 */
const targetOf = (spec) => {
  const raw = String(spec).replace(DEV_SPEC, '')
  // `file:../x` 也可能是相对路径，按 profile 目录展开；绝对路径原样。
  return path.isAbsolute(raw) ? raw : path.resolve(profileDir, raw)
}

/** 读某个目录下的 package.json（读不到/坏了返回 undefined）。 */
const readManifest = (dir) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

say(`profile：${profileDir}`)
if (!fs.existsSync(path.join(profileDir, 'package.json'))) fail('这个目录里没有 package.json，不是 profile 目录？')

const manifest = readManifest(profileDir)
if (manifest === undefined) fail('profile 的 package.json 读不出来（JSON 坏了？）')

const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : {}
const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? dsh.profile : {}
const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter((name) => typeof name === 'string') : []

const oldSpec = typeof dependencies[OLD_NAME] === 'string' ? dependencies[OLD_NAME] : undefined
const newSpec = typeof dependencies[NEW_NAME] === 'string' ? dependencies[NEW_NAME] : undefined
const oldInBundles = bundles.includes(OLD_NAME)
const newInBundles = bundles.includes(NEW_NAME)

if (oldSpec === undefined && newSpec === undefined) {
  fail(`profile 里既没有 ${OLD_NAME} 也没有 ${NEW_NAME}，没有可迁的本地安装`)
}

// ── 1. 验货：目录里的包名必须已经是新名 ──
const spec = newSpec ?? oldSpec
if (!DEV_SPEC.test(spec)) {
  fail(`依赖声明不是本地目录安装（${spec}），这不是这个脚本的活儿`)
}
const targetDir = targetOf(spec)
const target = readManifest(targetDir)
if (target === undefined) fail(`目标目录读不到 package.json：${targetDir}`)
if (target.name !== NEW_NAME) {
  fail(
    `目标目录的包名还是 ${target.name} —— 先去那里 git pull / 切到 ${NEW_NAME} 的版本，` +
      `否则改完 profile 指向一个名字对不上的目录，插件会直接加载失败。`,
  )
}
say(`本地目录：${targetDir}（${target.name}@${target.version}）`)

// ── 2. 算出清单改动 ──
const nextDependencies = { ...dependencies }
if (oldSpec !== undefined) {
  delete nextDependencies[OLD_NAME]
  // 两个键都在时以旧键的 spec 为准：它才是用户一直在用的那个路径。
  nextDependencies[NEW_NAME] = oldSpec
}
const nextBundles = (() => {
  if (!oldInBundles) {
    if (newInBundles) return bundles
    // 用户本来就没启用它 —— 不替他把插件塞回启用列表。
    return bundles
  }
  const at = bundles.indexOf(OLD_NAME)
  const rest = bundles.filter((name) => name !== OLD_NAME && name !== NEW_NAME)
  rest.splice(Math.min(at, rest.length), 0, NEW_NAME)
  return rest
})()

const manifestChanged =
  oldSpec !== undefined || JSON.stringify(nextBundles) !== JSON.stringify(bundles)

// ── 3. 算出 node_modules 改动 ──
const modulesDir = path.join(profileDir, 'node_modules')
const oldLink = path.join(modulesDir, OLD_NAME)
const newLink = path.join(modulesDir, NEW_NAME)
const oldLinkExists = fs.existsSync(oldLink) || isDanglingLink(oldLink)
const newLinkOk = (() => {
  try {
    return fs.statSync(newLink).isDirectory()
  } catch {
    return false
  }
})()

/** 目录联接被应用占着时 `existsSync` 可能为 false，用 lstat 兜一层。 */
function isDanglingLink(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

// ── 报告 ──
say('')
say('将要做的改动：')
say(`  依赖键    ${oldSpec === undefined ? '（已经是新名）' : `${OLD_NAME} → ${NEW_NAME}`}`)
say(`  启用列表  ${JSON.stringify(bundles)}`)
say(`            → ${JSON.stringify(nextBundles)}`)
say(`  node_modules  ${oldLinkExists ? '删除旧名联接；' : ''}${newLinkOk ? '新名联接已就绪' : `新建 ${NEW_NAME} → ${targetDir}`}`)

if (!manifestChanged && !oldLinkExists && newLinkOk) {
  say('')
  say('✓ 已经是新包名，什么都不用做。')
  process.exit(0)
}

if (dryRun) {
  say('')
  say('（--dry-run：没有写任何东西）')
  process.exit(0)
}

// ── 4. 写盘：先备份，再原子替换 ──
const backup = `${path.join(profileDir, 'package.json')}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
fs.copyFileSync(path.join(profileDir, 'package.json'), backup)
say('')
say(`备份：${backup}`)

if (manifestChanged) {
  const nextManifest = {
    ...manifest,
    dependencies: nextDependencies,
    dsh: { ...dsh, profile: { ...profile, bundles: nextBundles } },
  }
  const temp = path.join(profileDir, `.package.json.${process.pid}.tmp`)
  fs.writeFileSync(temp, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, path.join(profileDir, 'package.json'))
  say('✓ 清单已更新')
}

// ── 5. 修联接 ──
let oldLinkBlocked = false
if (oldLinkExists) {
  try {
    // rmdir 对目录联接只移除那一层，绝不跟进目标目录；对真实目录一定失败。
    fs.rmdirSync(oldLink)
    say(`✓ 已删除旧名联接 ${OLD_NAME}`)
  } catch (error) {
    oldLinkBlocked = true
    say(`! 旧名联接删不掉（${error.code ?? '未知'}）—— 多半是 DSH 正开着它，重启后再删：`)
    say(`    rmdir "${oldLink}"`)
  }
}

if (!newLinkOk) {
  fs.mkdirSync(modulesDir, { recursive: true })
  try {
    fs.symlinkSync(targetDir, newLink, process.platform === 'win32' ? 'junction' : 'dir')
    say(`✓ 已建立 ${NEW_NAME} → ${targetDir}`)
  } catch (error) {
    fail(`建立联接失败：${error.code ?? error.message}（可能需要管理员权限）`)
  }
}

// ── 6. 回读验证：名字对不上等于白改 ──
const installed = readManifest(newLink)
if (installed === undefined || installed.name !== NEW_NAME) {
  fail(`回读失败：经 ${newLink} 读到的包名是 ${installed?.name ?? '（读不到）'}`)
}
say('')
say(`✓ 完成：${installed.name}@${installed.version}`)
if (oldLinkBlocked) say(`  旧联接仍在（${oldLink}），重启 DSH 后删掉即可 —— 它已经不被任何配置引用。`)
say('  重启 DSH 后生效。')
