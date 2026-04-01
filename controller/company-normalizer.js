function normalizeCompanyName(input) {
  if (typeof input !== 'string') {
    return '';
  }

  let value = input.trim();
  if (!value) {
    return '';
  }

  value = value
    .replace(/\u3000/g, ' ')
    .replace(/[（）]/g, (match) => (match === '（' ? '(' : ')'))
    .replace(/\s+/g, ' ');

  // 保守归一：仅处理尾部地域括号，不删除主体词。
  value = value.replace(/\s*\((北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|苏州)\)\s*$/u, '');

  return value.trim();
}

module.exports = {
  normalizeCompanyName
};
