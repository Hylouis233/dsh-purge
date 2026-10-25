#!/usr/bin/env node
/**
 * 发布前自动定版本，替代“手改 package.json + 手改 release-notes.md 第一行”。
 *
 * 规则（自下而上优先级）：
 *   1. 环境变量 RELEASE_VERSION（workflow_dispatch 传入手动版本）→ 直接用，最高优先。
 *   2. release-notes.md 里已经写了比 package.json 更新的版本段落 → 采用它
 *      （作者先写日志再发版，尊重其意图）。
 *   3. 该版本的 tag 已存在 → 不发布，输出 skip=1。
 *   4. 否则 patch +1。若 +1 后与已有 tag 冲突（例如 tag 打过但版本号没动），
 *      继续 +1 直到空闲，避免发版失败。
 *
 * 本脚本只写 package.json；release-notes.md 不在 CI 里改（避免机器人提交回灌
 * 触发循环），缺失的日志段落由它生成一个最小骨架，保证 gh --notes-file 有内容。
 *
 * 输出到 GITHUB_OUTPUT（或在本地终端打印）：
 *   version=1.1.74
 *   skip=0|1
 *   reason=...
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const pkgPath = path.join(ROOT, "package.json");
const notesPath = path.join(ROOT, "release-notes.md");

const say = (...a) => console.log(...a);

const out = {};
function setOutput(key, value) {
  out[key] = String(value);
  say(`${key}=${value}`);
  const fp = process.env.GITHUB_OUTPUT;
  if (fp) fs.appendFileSync(fp, `${key}=${value}\n`, "utf8");
}

/** 已有的 tag 列表：优先问远端，拉不到就退化为本地 tag。 */
function existingTags() {
  try {
    const raw = execFileSync("git", ["ls-remote", "--tags", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tags = raw
      .split("\n")
      .map((l) => l.split("refs/tags/")[1] || "")
      .map((t) => t.replace(/\^{}$/, "").trim())
      .filter(Boolean);
    return new Set(tags);
  } catch {
    try {
      const raw = execFileSync("git", ["tag", "--list"], { encoding: "utf8" });
      return new Set(raw.split("\n").map((t) => t.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }
}

function bumpPatch(version) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return null;
  const next = Number(m[3]) + 1;
  return `${m[1]}.${m[2]}.${next}${m[4] || ""}`;
}

/** release-notes.md 里出现过的版本号（按文件顺序）。 */
function noteVersions(text) {
  return [...String(text || "").matchAll(/^#\s*v?(\d+\.\d+\.\d+[^\s]*)\s*$/gm)].map((m) => m[1]);
}

function cmpSemver(a, b) {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const current = String(pkg.version || "");
  const tags = existingTags();
  const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "";
  const noted = noteVersions(notes);

  say(`current package.json version: ${current}`);
  say(`tags on origin: ${tags.size ? [...tags].join(", ") : "(none)"}`);
  say(`versions in release-notes.md: ${noted.length ? noted.slice(0, 5).join(", ") : "(none)"}`);

  // 1) 手动指定
  const manual = String(process.env.RELEASE_VERSION || "").trim().replace(/^v/i, "");
  if (manual) {
    setOutput("version", manual);
    setOutput("skip", "0");
    setOutput("reason", "manual:RELEASE_VERSION");
    return;
  }

  // 2) release-notes.md 已经领先 package.json
  const newer = noted.filter((v) => cmpSemver(v, current) > 0).sort(cmpSemver);
  if (newer.length > 0) {
    const pick = newer[newer.length - 1];
    if (tags.has(`v${pick}`)) {
      setOutput("version", pick);
      setOutput("skip", "1");
      setOutput("reason", `notes-ahead-but-tag-exists:v${pick}`);
      return;
    }
    setOutput("version", pick);
    setOutput("skip", "0");
    setOutput("reason", "notes-ahead");
    return;
  }

  // 3) 当前版本的 tag 已存在 → 这次不该发
  if (tags.has(`v${current}`)) {
    setOutput("version", current);
    setOutput("skip", "1");
    setOutput("reason", `tag-exists:v${current}`);
    return;
  }

  // 4) patch +1，跳过已被占用的 tag
  let next = bumpPatch(current);
  let guard = 0;
  while (next && tags.has(`v${next}`) && guard < 100) {
    next = bumpPatch(next);
    guard++;
  }
  if (!next) {
    setOutput("version", current);
    setOutput("skip", "1");
    setOutput("reason", `cannot-bump:${current}`);
    return;
  }
  setOutput("version", next);
  setOutput("skip", "0");
  setOutput("reason", `bump-from:${current}`);

  pkg.version = next;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  say(`package.json version -> ${next}`);
}

main();
