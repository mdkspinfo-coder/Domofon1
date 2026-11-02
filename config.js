// Настройки сервера. Пока здесь заглушки, приложение работает в локальном режиме (метки только на этом телефоне).
// Как получить значения, написано в README.md (раздел «Подключение сервера»).
//
// Ключ anon публичный по задумке Supabase: его можно хранить в открытом репозитории.
// Защищают данные правила доступа из supabase/schema.sql, а не секретность ключа.
// Никогда не вставляй сюда ключ service_role.
export const CONFIG = {
  SUPABASE_URL: 'vfvnttjawbmwhkdhvbfh',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmdm50dGphd2Jtd2hrZGh2YmZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MTU3MzYsImV4cCI6MjEwOTE5MTczNn0.X6Au52WaeIVy9AOHrOvixx20aGEbQZzNJDwJsaYm_Fo',
  // Какие способы входа включены. Apple заработает, только когда настроен Sign in with Apple
  // (нужна платная программа Apple Developer). Тогда поставь apple: true.
  PROVIDERS: { google: true, apple: false },
  // Данные оператора (того, кто отвечает за сервис). Они подставляются в политику конфиденциальности,
  // согласие и правила. Пока значения в квадратных скобках, на этих страницах виден красный баннер.
  // Это публичные данные: они будут показаны всем пользователям.
  OPERATOR: {
    NAME: '[ИМЯ ИЛИ НАЗВАНИЕ ОПЕРАТОРА]',
    EMAIL: '[EMAIL ДЛЯ ОБРАЩЕНИЙ]',
    ADDRESS: '[АДРЕС ОПЕРАТОРА]',
  },
};
