/** Source-only inputs for both document sync modes. Unknown file types are excluded. */
import { posix } from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro',
  '.razor', '.cshtml', '.jsp', '.jspx', '.ftl', '.vm', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl', '.pug', '.ejs', '.hbs', '.erb',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.gradle', '.go', '.rs', '.py', '.pyi', '.rb',
  '.php', '.phtml', '.cs', '.fs', '.fsx', '.vb', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx',
  '.m', '.mm', '.swift', '.dart', '.ex', '.exs', '.erl', '.hrl', '.hs', '.lhs', '.clj', '.cljs',
  '.cljc', '.lua', '.r', '.jl', '.pl', '.pm', '.pas', '.f', '.f90', '.f95', '.cob',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd', '.awk', '.sed',
  '.sql', '.proto', '.graphql', '.gql', '.thrift', '.prisma', '.sol', '.tf', '.hcl', '.cmake',
]);
const SOURCE_NAMES = new Set(['makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'jenkinsfile', 'rakefile', 'gemfile', 'cmakelists.txt']);
const GENERATED_DIRS = /(^|\/)(?:docs?|documentation|wiki|node_modules|vendor|dist|build|target|coverage|__pycache__|\.next|\.nuxt|\.git|sync-logs)(?:\/|$)/i;
const TEST_DIRS = /(^|\/)(?:tests?|__tests__|specs?|__mocks__|mocks?|fixtures|__fixtures__|__snapshots__|testdata|e2e|cypress|androidTest|testFixtures|test[-_]utils|(?:unit|integration|functional|acceptance|performance|smoke)[-_]tests?|[^/]+[._-](?:tests?|specs?)|test-results|playwright-report)(?:\/|$)/i;
const TEST_NAMES = /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)|^(?:conftest\.py|(?:jest|vitest|playwright|cypress|karma)\.)/i;
const TEST_CLASS_NAMES = /(?:Tests?|TestCase|Spec|[a-z0-9]IT)\.[^.]+$|^(?:Test|Spec)[A-Z_]/;

export function isSyncCodeFile(file) {
  const path = file.replaceAll('\\', '/');
  const name = posix.basename(path).toLowerCase();
  if (TEST_DIRS.test(path) || TEST_NAMES.test(name) || TEST_CLASS_NAMES.test(posix.basename(path))) return false;
  if (GENERATED_DIRS.test(path) || /(?:\.min\.(?:js|css)|\.generated\.[^.]+|\.g\.cs|_pb2(?:_grpc)?\.py|\.pb\.go)$/.test(name)) return false;
  return SOURCE_NAMES.has(name) || /^(?:dockerfile|containerfile)\./.test(name) || SOURCE_EXTENSIONS.has(posix.extname(name));
}

/** Decode Git's C-quoted paths, including octal UTF-8 bytes and escaped whitespace. */
function decodeGitPath(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [];
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] === '\\') {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length + 1; }
      else { bytes.push(escapes[body[i + 1]] ?? body.charCodeAt(i + 1)); i += 2; }
    } else {
      const char = String.fromCodePoint(body.codePointAt(i));
      bytes.push(...Buffer.from(char)); i += char.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Preserve layer labels and exact patches, accepting only text source-file changes. */
export function parseSyncCodeDiff(diff, { withRanges = false } = {}) {
  const files = [];
  let layer = '';
  let offset = 0;
  for (const section of (diff || '').split(/(?=^# (?:已提交的变更|已暂存但未提交的变更|未暂存的变更|未跟踪的新文件)$)|(?=^diff --git )/m)) {
    const start = offset; offset += section.length;
    if (section.startsWith('# ')) { layer = section.split('\n')[0]; continue; }
    if (!section.startsWith('diff --git ') || /^(?:Binary files |GIT binary patch)/m.test(section)) continue;
    const header = section.split(/^@@/m)[0];
    const newPath = header.match(/^\+\+\+ (.+)$/m)?.[1];
    const oldPath = header.match(/^--- (.+)$/m)?.[1];
    const headerPath = header.split('\n')[0].match(/^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/)?.[2];
    const rawPath = newPath && newPath !== '/dev/null' ? newPath : oldPath || headerPath;
    if (!rawPath) continue;
    const file = decodeGitPath(rawPath.replace(/\r$/, '')).replace(/^[ab]\//, '');
    if (!isSyncCodeFile(file)) continue;
    files.push({ file, content: (layer ? layer + '\n' : '') + section.trimEnd(), ...(withRanges ? { parts: [...(layer ? [layer + '\n'] : []), { sourceId: 'code.input', start, end: start + section.trimEnd().length }] } : {}) });
  }
  return files;
}

export function filterSyncCodeDiff(diff) {
  return parseSyncCodeDiff(diff).map(file => file.content).join('\n\n');
}
