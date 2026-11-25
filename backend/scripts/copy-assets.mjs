/**
 * 构建后把 backend/assets（字体和 OFL 许可证）复制到 dist/backend/assets，
 * 保证构建产物运行时也能注册标签字体。
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', 'assets');
const target = resolve(here, '..', '..', 'dist', 'backend', 'assets');
const required = ['fonts/NotoSansSC-Regular.ttf', 'fonts/OFL.txt'];

for (const relative of required) {
  if (!existsSync(resolve(source, relative))) {
    console.error(`缺少标签资源：${resolve(source, relative)}`);
    process.exit(1);
  }
}

cpSync(source, target, { recursive: true });

for (const relative of required) {
  if (!existsSync(resolve(target, relative))) {
    console.error(`资源复制失败：${resolve(target, relative)}`);
    process.exit(1);
  }
}

console.log(`已复制标签资源到 ${target}`);
