/**
 * 课程名 → 工作区目录 的映射。
 *
 * 课后总结要写进「这门课自己的目录」，而用户开课时敲的课程名是自由的
 * （可能是「数据结构」，也可能是「数构」或「数据结构习题课」）。权威依据是
 * `学习台/课程.json`：每门课有 `name`、`aliases`，还有一句人写的 `note`
 * （形如「工作区目录：物理/」）。三档依次退化：
 *
 *   1. note 里点名的目录（最准，人写的）
 *   2. 课程名 / 别名里，真的在工作区存在的那一个
 *   3. 用户敲的字符串里**包含**的某个工作区目录名（「数据结构习题课」→ `数据结构`）
 *
 * 全都落空时返回 null，由调用方退回 `<dataDir>/笔记/` —— **绝不在用户的
 * 作业目录里凭空建一个课程文件夹**。
 *
 * 这一层刻意做成纯函数（目录清单由参数传进来），好钉死、好测。
 */

/** 课程目录下放笔记的子目录名。 */
export const NOTES_DIR = '笔记';

/** 课程名归一化：去空白、压连续空格。大小写不敏感的比较交给调用方。 */
export function normalizeCourseName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** 从课程名的 note 里抠出「工作区目录：物理/」这种写法的目录名。 */
export function noteDirName(note) {
  if (typeof note !== 'string') return '';
  const matched = note.match(/目录\s*[:：]\s*([^\s/\\、，,；;]+)/);
  if (matched === null) return '';
  return normalizeCourseName(matched[1]);
}

/**
 * 在 `课程.json` 的课程表里找一门课。
 *
 * 优先级：课程名全等 > 别名全等 > 课程名互相包含 > 别名互相包含。
 * 都不中返回 null（用户可能敲了一门课表里没有的课，那也正常）。
 */
export function matchCourse(courses, typed) {
  const wanted = normalizeCourseName(typed);
  if (wanted === '' || !Array.isArray(courses)) return null;
  const lower = wanted.toLowerCase();
  const fields = (course) => [normalizeCourseName(course.name), ...(Array.isArray(course.aliases) ? course.aliases.map(normalizeCourseName) : [])];

  for (const course of courses) {
    if (normalizeCourseName(course?.name).toLowerCase() === lower) return course;
  }
  for (const course of courses) {
    if (fields(course).slice(1).some((alias) => alias.toLowerCase() === lower)) return course;
  }
  for (const course of courses) {
    if (fields(course).some((field) => field !== '' && lower.includes(field.toLowerCase()))) return course;
  }
  for (const course of courses) {
    if (fields(course).some((field) => field !== '' && field.toLowerCase().includes(lower))) return course;
  }
  return null;
}

/**
 * 纯函数：从「用户敲的名字 + 课程表 + 工作区里真实存在的目录名」里挑一个目录。
 *
 * @returns {{ dirName: string, via: 'note'|'name'|'alias'|'scan'|'' }}
 *          `dirName` 为空串表示放弃，请回到 `<dataDir>/笔记/`。
 */
export function pickCourseDir({ typed, courses, dirNames }) {
  const wanted = normalizeCourseName(typed);
  const dirs = Array.isArray(dirNames) ? dirNames : [];
  const has = (candidate) => candidate !== '' && dirs.includes(candidate);

  const course = matchCourse(courses, wanted);
  if (course !== null) {
    const fromNote = noteDirName(course.note);
    if (has(fromNote)) return { dirName: fromNote, via: 'note' };
    const name = normalizeCourseName(course.name);
    if (has(name)) return { dirName: name, via: 'name' };
    const aliases = (Array.isArray(course.aliases) ? course.aliases : []).map(normalizeCourseName).filter(has);
    if (aliases.length > 0) {
      // 别名可能有好几个，长的更具体：「数电实验」优于「数电」
      aliases.sort((a, b) => b.length - a.length);
      return { dirName: aliases[0], via: 'alias' };
    }
  }

  // 课程表里没这门课（或者它的目录还没建）：看看用户敲的字符串里有没有现成的目录名
  if (wanted !== '') {
    const lower = wanted.toLowerCase();
    const hits = dirs.filter((dir) => dir.toLowerCase() !== '' && lower.includes(dir.toLowerCase()));
    if (hits.length > 0) {
      hits.sort((a, b) => b.length - a.length);
      return { dirName: hits[0], via: 'scan' };
    }
  }

  return { dirName: '', via: '' };
}
