// Shared by the popup and the history page: the CSV backups of jobs.

// Quotes a cell when needed. A cell that starts with =, +, -, @, a tab or a carriage return gets a
// leading ' so spreadsheet apps show it as text instead of evaluating it: backups hold posts by
// other people, and replies start with @.
function csvEscape(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Saves the lines as a UTF-8 CSV with a byte order mark, so Excel reads accents correctly. The URL
// is revoked a minute later: revoking it right after click() can cancel a large download.
function downloadCsv(lines, filename) {
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
