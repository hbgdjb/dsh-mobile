/* ============================================================
   精简 semver —— 只做插件依赖解析需要的部分

   ============ 为什么自己写 ============
   
   手机端不能 npm install，所以我们自己把依赖装进 node_modules。
   要装，第一件事就是回答「`^0.1.7-rc.1 || ^0.2.0-rc.1` 该装哪个版本」。

   完整 semver 库 30 KB，而这里需要的只有：
   
     · 解析版本号（含预发布）
     · 比较大小
     · 匹配范围：^ ~ >= <= > < = x.* || 空格（AND）

   覆盖 npm 生态里 95% 以上的写法。遇到不认识的记号直接报错，
   而不是猜 —— 装错版本比装不上更难查。

   ============ 预发布为什么特殊 ============
   
   npm 的规矩：`^1.2.3` **不会**匹配 `1.2.4-beta.1`，除非范围里
   自己写了预发布（`^1.2.3-beta.1`）。DSH 生态里预发布版本极多
   （`0.1.7-rc.1`、`0.2.1-alpha.3`），这条规则不实现会装错主版本。
   ============================================================ */

/** 解析 `1.2.3-beta.1+build` → { major, minor, patch, pre: [], build } */
export function parseVersion(text) {
  const raw = String(text || '').trim().replace(/^v/, '');
  const m = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] || '',
    raw,
  };
}

/** 宽松解析：`1.2` / `1` 也能认，缺的位置补 0。范围里的简写要用它。 */
export function parseLoose(text) {
  const raw = String(text || '').trim().replace(/^v/, '');
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] || '',
    // 记下原本写了几段，^ 和 ~ 的语义依赖这个
    given: m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1,
    raw,
  };
}

/** 比较两个预发布标识符（semver 第 11 条）。 */
function comparePre(a, b) {
  // 没有预发布 > 有预发布
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d > 0 ? 1 : -1;
      continue;
    }
    // 数字标识符优先级低于字母
    if (nx) return -1;
    if (ny) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 版本比较：a > b 返回 1，< 返回 -1，相等 0。 */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) throw new Error(`版本号解析不了：${va ? b : a}`);

  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return comparePre(va.pre, vb.pre);
}

/**
 * 一个比较器：{ op, version }。
 *
 * version 在这里就解析成对象 —— 后面「预发布只允许同 triple」的检查
 * 要读 major/minor/patch，存字符串会读到 undefined，那条规则就永远不生效。
 */
function makeComparator(op, version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) throw new Error(`比较器里的版本号解析不了：${version}`);
  return { op, version: v };
}

function testComparator(v, c) {
  const d = compareVersions(v, c.version);
  switch (c.op) {
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '=':
      return d === 0;
    default:
      return false;
  }
}

/**
 * 把一个范围表达式拆成「若干组比较器」，组之间是 OR。
 *
 * `^1.2.3` → [[>=1.2.3, <2.0.0]]
 * `^1 || ^2` → [[>=1 <2], [>=2 <3]]
 */
export function parseRange(range) {
  const text = String(range || '').trim();
  if (!text || text === '*' || text === 'latest' || text === 'x') {
    return { any: true, groups: [] };
  }

  const groups = [];
  for (const part of text.split('||')) {
    const chunk = part.trim();
    if (!chunk) continue;

    // 空格 = AND；`>= 1.2.3` 这种带空格的比较符要先粘回去
    const tokens = chunk
      .replace(/([<>=]+)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);

    const comparators = [];
    for (const token of tokens) {
      comparators.push(...expandToken(token));
    }
    if (comparators.length) groups.push(comparators);
  }

  if (!groups.length) return { any: true, groups: [] };
  return { any: false, groups };
}

/** 单个记号 → 比较器列表。 */
function expandToken(token) {
  // x / * / 1.x / 1.2.x
  if (/^[xX*]$/.test(token)) return [];

  const m = token.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) throw new Error(`看不懂的版本范围记号：${token}`);
  const op = m[1] || '=';
  const rest = m[2];

  // 带 x 的简写：1.x / 1.2.x
  const wildcard = rest.match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (wildcard && /[xX*]/.test(rest)) {
    const major = Number(wildcard[1]);
    const minorRaw = wildcard[2];
    if (minorRaw === undefined || /[xX*]/.test(minorRaw)) {
      return [makeComparator('>=', `${major}.0.0`), makeComparator('<', `${major + 1}.0.0`)];
    }
    const minor = Number(minorRaw);
    return [makeComparator('>=', `${major}.${minor}.0`), makeComparator('<', `${major}.${minor + 1}.0`)];
  }

  const v = parseLoose(rest);
  if (!v) throw new Error(`看不懂的版本号：${rest}`);

  if (op === '^') {
    // ^0.2.3 → >=0.2.3 <0.3.0 ；^0.0.3 → >=0.0.3 <0.0.4 ；^1.2.3 → <2.0.0
    const base = `${v.major}.${v.minor}.${v.patch}${v.pre.length ? '-' + v.pre.join('.') : ''}`;
    let upper;
    if (v.major > 0) upper = `${v.major + 1}.0.0`;
    else if (v.given === 1) upper = `1.0.0`;
    else if (v.minor > 0) upper = `0.${v.minor + 1}.0`;
    else if (v.given === 2) upper = `0.1.0`;
    else upper = `0.0.${v.patch + 1}`;
    return [makeComparator('>=', base), makeComparator('<', upper)];
  }

  if (op === '~') {
    // ~1.2.3 → >=1.2.3 <1.3.0 ；~1.2 → >=1.2.0 <1.3.0 ；~1 → >=1.0.0 <2.0.0
    const base = `${v.major}.${v.minor}.${v.patch}${v.pre.length ? '-' + v.pre.join('.') : ''}`;
    const upper = v.given === 1 ? `${v.major + 1}.0.0` : `${v.major}.${v.minor + 1}.0`;
    return [makeComparator('>=', base), makeComparator('<', upper)];
  }

  const exact = `${v.major}.${v.minor}.${v.patch}${v.pre.length ? '-' + v.pre.join('.') : ''}`;
  if (op === '=') {
    // `1.2` 这种写法在 npm 里等价于 `1.2.x`
    if (v.given < 3) {
      const upper = v.given === 1 ? `${v.major + 1}.0.0` : `${v.major}.${v.minor + 1}.0`;
      return [makeComparator('>=', exact), makeComparator('<', upper)];
    }
    return [makeComparator('=', exact)];
  }
  return [makeComparator(op, exact)];
}

/**
 * 判断某个版本是否落在某个范围里。
 *
 * @param {string} version 具体版本
 * @param {string} range 范围表达式
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;

  const parsed = parseRange(range);
  if (parsed.any) {
    // `*` 不匹配预发布 —— npm 的行为
    return v.pre.length === 0;
  }

  // 范围里有没有写预发布？没写的话，预发布版本一律不匹配
  const rangeHasPre = /-[0-9A-Za-z.-]+/.test(String(range || ''));

  for (const group of parsed.groups) {
    if (!group.every((c) => testComparator(v, c))) continue;

    if (v.pre.length && !rangeHasPre) continue;

    // 写了预发布的范围：只允许同一个 major.minor.patch 的预发布
    if (v.pre.length && rangeHasPre) {
      const sameTriple = group.some(
        (c) =>
          c.version.major === v.major &&
          c.version.minor === v.minor &&
          c.version.patch === v.patch
      );
      if (!sameTriple) continue;
    }
    return true;
  }
  return false;
}

/**
 * 从一堆版本里挑出符合范围的最高版本。
 *
 * @param {string[]} versions 可选版本列表（顺序无所谓）
 * @param {string} range
 * @returns {string|null} 挑不出来返回 null
 */
export function maxSatisfying(versions, range) {
  const list = (Array.isArray(versions) ? versions : []).filter((v) => parseVersion(v));
  const ok = list.filter((v) => satisfies(v, range));
  if (!ok.length) return null;
  return ok.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}
