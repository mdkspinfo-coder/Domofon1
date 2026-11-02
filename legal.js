// Подставляет данные оператора из config.js в документы и показывает баннер, пока что-то не заполнено.
import { CONFIG } from './config.js';

const op = CONFIG.OPERATOR || {};
document.querySelectorAll('[data-op]').forEach((node) => {
  const key = node.dataset.op.toUpperCase();
  const value = String(op[key] || '[НЕ ЗАПОЛНЕНО]');
  const todo = value.startsWith('[');
  if (key === 'EMAIL' && !todo) {
    const a = document.createElement('a');
    a.href = `mailto:${value}`;
    a.textContent = value;
    node.replaceWith(a);
    return;
  }
  node.textContent = value;
  if (todo) node.classList.add('todo');
});
if (document.querySelector('.todo')) document.getElementById('todoBanner').hidden = false;
