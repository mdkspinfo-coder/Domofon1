// Панель модерации. Доступ определяет СЕРВЕР: каждая функция mod_* / owner_* проверяет роль сама.
// Эта страница только показывает данные и отправляет решения; скрытие вкладок для модератора - это удобство, а не защита.
import { CONFIG } from './config.js';
import { createStore } from './store.js';

const store = createStore(CONFIG);
const $ = (id) => document.getElementById(id);

let role = null;
let tab = 'open';
let toastTimer = null;

const REASONS = {
  wrong_code: 'Код не подходит или устарел',
  fake: 'Выдуманная метка или спам',
  private: 'Частная территория',
  abuse: 'Оскорбительное название',
  other: 'Другое',
};
const ACTIONS = {
  dismiss: 'Жалоба отклонена',
  delete_marker: 'Метка удалена',
  delete_and_ban: 'Метки автора удалены, автор заблокирован',
};
const ERR = {
  forbidden: 'Нет доступа для этого аккаунта.',
  auth_required: 'Войдите в аккаунт.',
  user_not_found: 'Человек с такой почтой ещё ни разу не входил в приложение. Пусть сначала войдёт через Google, потом добавьте его.',
  already_staff: 'Этот человек уже в команде.',
  not_found: 'Не найдено (возможно, уже обработано).',
  already_handled: 'Эту жалобу уже обработал другой модератор.',
  cannot_ban_staff: 'Сотрудника команды заблокировать нельзя. Сначала снимите его с роли модератора.',
  author_unknown: 'Автор метки неизвестен (его аккаунт удалён), блокировать некого.',
  not_configured: 'Сервер ещё не подключён.',
  lib_failed: 'Не удалось загрузить сервер. Проверьте интернет и перезагрузите страницу.',
};
const errText = (e) => ERR[e?.code] || ERR[e?.message] || 'Не получилось выполнить действие. Проверьте интернет и повторите.';

// Создание элементов без innerHTML: названия, комментарии и почты приходят от пользователей.
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU') : '');
const osmLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;

function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function gate(message, { login = false, logout = false } = {}) {
  $('tabs').hidden = true;
  $('content').hidden = true;
  $('gate').hidden = false;
  $('gateMsg').textContent = message;
  $('gateLogin').hidden = !login;
  $('gateLogout').hidden = !logout;
}

$('gateLogin').addEventListener('click', async () => {
  try {
    await store.signIn('google');
  } catch (e) {
    toast(errText(e), 5000);
  }
});
$('gateLogout').addEventListener('click', async () => {
  try {
    await store.signOut();
  } finally {
    location.reload();
  }
});

// ---------- Вкладки ----------
document.querySelectorAll('#tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
  }),
);

async function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const box = $('content');
  box.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
  try {
    if (tab === 'open' || tab === 'handled') await renderReports(box, tab);
    else if (tab === 'banned') await renderBanned(box);
    else if (tab === 'team') await renderTeam(box);
  } catch (e) {
    box.replaceChildren(el('div', { class: 'empty', text: errText(e) }));
  }
}

// ---------- Жалобы ----------
async function renderReports(box, which) {
  const list = await store.call('mod_list_reports', { p_status: which });
  if (which === 'open') $('cntOpen').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'empty', text: which === 'open' ? 'Новых жалоб нет.' : 'Обработанных жалоб пока нет.' }));
    return;
  }
  box.replaceChildren(...list.map((r) => reportCard(r, which === 'handled')));
}

function reportCard(r, handled) {
  const note = el('input', { placeholder: 'Заметка для журнала (необязательно)', maxlength: '300' });
  const resolve = (action, confirmText) => async () => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await store.call('mod_resolve_report', { p_report: r.id, p_action: action, p_note: note.value.trim() });
      toast('Готово');
      await render();
    } catch (e) {
      toast(errText(e), 5000);
      if (e?.message === 'already_handled') render();
    }
  };

  const gone = !r.marker_id;
  const head = el('div', { class: 'row' },
    el('b', { text: REASONS[r.reason] || r.reason }),
    r.open_on_marker > 1 && !handled ? el('span', { class: 'badge red', text: `жалоб на метку: ${r.open_on_marker}` }) : null,
    el('span', { class: 'muted', text: fmt(r.created_at) }),
  );

  const card = el('div', { class: 'card', 'data-report': r.id },
    head,
    el('div', { class: 'kv' }, el('b', { text: 'Метка: ' }), r.marker_title || 'без названия', ' · ',
      el('a', { href: osmLink(r.marker_lat, r.marker_lon), target: '_blank', rel: 'noopener', text: 'на карте' })),
    gone
      ? el('div', { class: 'muted', text: 'Метка уже удалена.' })
      : el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Код:' }), el('span', { class: 'code', text: r.code ?? '—' })),
    el('div', { class: 'kv' }, el('b', { text: 'Автор: ' }), r.author_email || 'аккаунт удалён',
      r.author_banned ? el('span', { class: 'badge red', text: ' заблокирован' }) : null),
    r.reporter_email ? el('div', { class: 'kv' }, el('b', { text: 'Пожаловался: ' }), r.reporter_email) : null,
    r.comment ? el('div', { class: 'quote', text: r.comment }) : null,
  );

  if (handled) {
    card.append(
      el('div', { class: 'kv' }, el('b', { text: 'Решение: ' }), ACTIONS[r.action] || r.action, ' · ', fmt(r.handled_at)),
      r.note ? el('div', { class: 'quote', text: r.note }) : null,
    );
    return card;
  }

  card.append(
    note,
    el('div', { class: 'actions' },
      el('button', { class: 'btn', text: 'Оставить метку, отклонить жалобу', onclick: resolve('dismiss') }),
      el('button', {
        class: 'btn danger',
        text: gone ? 'Закрыть жалобу (метка уже удалена)' : 'Удалить метку',
        onclick: resolve('delete_marker', gone ? null : 'Удалить эту метку? Все жалобы на неё закроются.'),
      }),
      el('button', {
        class: 'btn danger',
        text: 'Удалить ВСЕ метки автора и заблокировать его',
        disabled: !r.author_id || r.author_banned,
        onclick: resolve('delete_and_ban', 'Удалить ВСЕ метки этого автора и заблокировать его почту? Заблокированный не сможет пользоваться сервисом, даже создав новый аккаунт с той же почтой.'),
      }),
    ),
  );
  return card;
}

// ---------- Блокировки ----------
async function renderBanned(box) {
  const list = await store.call('mod_list_banned');
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'empty', text: 'Заблокированных нет.' }));
    return;
  }
  box.replaceChildren(...list.map((b) =>
    el('div', { class: 'card', 'data-banned': b.email },
      el('b', { text: b.email }),
      b.reason ? el('div', { class: 'quote', text: b.reason }) : null,
      el('div', { class: 'muted', text: `с ${fmt(b.created_at)}` }),
      role === 'owner'
        ? el('div', { class: 'row' }, el('button', {
            class: 'btn',
            text: 'Разблокировать',
            onclick: async () => {
              if (!confirm(`Разблокировать ${b.email}?`)) return;
              try {
                await store.call('owner_unban', { p_email: b.email });
                toast('Разблокирован');
                render();
              } catch (e) {
                toast(errText(e), 5000);
              }
            },
          }))
        : el('div', { class: 'muted', text: 'Разблокировать может только владелец.' }),
    ),
  ));
}

// ---------- Команда (только владелец) ----------
async function renderTeam(box) {
  const staff = await store.call('owner_list_staff');
  const email = el('input', { type: 'email', placeholder: 'Почта человека (та, которой он входит через Google)', autocomplete: 'off' });
  const add = el('button', {
    class: 'btn primary',
    text: 'Добавить модератором',
    onclick: async () => {
      const v = email.value.trim();
      if (!v) return toast('Введите почту.');
      try {
        await store.call('owner_add_moderator', { p_email: v });
        toast('Модератор добавлен');
        render();
      } catch (e) {
        toast(errText(e), 6000);
      }
    },
  });
  box.replaceChildren(
    el('div', { class: 'card' },
      el('b', { text: 'Добавить модератора' }),
      el('div', { class: 'muted', text: 'Модератор видит жалобы, коды и почту автора метки, удаляет метки и блокирует нарушителей. Почту пожаловавшегося и список команды видит только владелец. Человек должен хотя бы раз войти в приложение.' }),
      email,
      el('div', { class: 'row' }, add),
    ),
    ...staff.map((s) =>
      el('div', { class: 'card', 'data-staff': s.email },
        el('div', { class: 'row' }, el('b', { text: s.email }), el('span', { class: 'badge', text: s.role === 'owner' ? 'Владелец' : 'Модератор' })),
        el('div', { class: 'muted', text: `с ${fmt(s.created_at)}` }),
        s.role === 'moderator'
          ? el('div', { class: 'row' }, el('button', {
              class: 'btn danger',
              text: 'Снять с роли',
              onclick: async () => {
                if (!confirm(`Снять ${s.email} с роли модератора?`)) return;
                try {
                  await store.call('owner_remove_moderator', { p_user: s.user_id });
                  toast('Снят с роли');
                  render();
                } catch (e) {
                  toast(errText(e), 5000);
                }
              },
            }))
          : null,
      ),
    ),
  );
}

// ---------- Запуск ----------
async function boot() {
  if (store.kind !== 'remote') return gate(errText({ message: store.reason }));
  let user;
  try {
    user = await store.init();
  } catch {
    return gate('Не удалось связаться с сервером. Проверьте интернет и перезагрузите страницу.');
  }
  if (/[?&](code|error|error_description)=|access_token=/.test(location.search + location.hash)) {
    history.replaceState(null, '', location.pathname);
  }
  if (!user) return gate('Войдите аккаунтом владельца или модератора.', { login: true });
  $('whoMail').textContent = user.email;
  try {
    role = await store.call('my_role');
  } catch {
    return gate('Не удалось проверить доступ. Проверьте интернет и перезагрузите страницу.');
  }
  if (!role) return gate(`У аккаунта ${user.email} нет доступа к модерации. Войдите другим аккаунтом.`, { login: true, logout: true });

  $('whoRole').hidden = false;
  $('whoRole').textContent = role === 'owner' ? 'Владелец' : 'Модератор';
  $('tabs').hidden = false;
  $('tabTeam').hidden = role !== 'owner';
  $('gate').hidden = true;
  $('content').hidden = false;
  render();
}
boot();
