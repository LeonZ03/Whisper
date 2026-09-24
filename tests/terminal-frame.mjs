import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// Capture only the synthetic test terminal's current display, never a user's terminal.
export function terminalFrame(terminal) {
  const color = (cell, side) => ({
    mode: cell[`is${side}Default`]() ? 'default' : cell[`is${side}RGB`]() ? 'rgb' : 'palette',
    value: cell[`get${side}Color`](),
  });
  const rows = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y), cells = [];
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line?.getCell(x); if (!cell || cell.getWidth() === 0) continue;
      cells.push({ text: cell.getChars() || ' ', width: cell.getWidth(), fg: color(cell, 'Fg'), bg: color(cell, 'Bg'),
        bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()), inverse: Boolean(cell.isInverse()) });
    }
    rows.push(cells);
  }
  return { source: 'Synthetic accounts in real Windows PowerShell / ConPTY', cols: terminal.cols, rows };
}
export function writeTerminalFrame(terminal, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(terminalFrame(terminal)), 'utf8');
}
