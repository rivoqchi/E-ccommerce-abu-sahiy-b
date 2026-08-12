export const BTN_SHARE_PHONE = '📱 Raqamni yuborish';
export const BTN_MY_ORDERS = 'Buyurtmalarim';
export const BTN_SEND_CODE = 'Kod yuborish';
export const BTN_OPEN_WEB = 'Open Web';
export const BTN_MINI_APP = 'Mini App';

export const texts = {
  welcomeNeedPhone:
    'Assalomu alaykum! 👋\n\nSaytdan ro‘yxatdan o‘tish uchun telefon raqamingizni yuboring.',
  welcomeReady:
    'Assalomu alaykum! 👋\n\nQuyidagi menyudan kerakli bo‘limni tanlang.\n\n• Open Web — sayt avtomatik ochiladi (kod shart emas)\n• Kod yuborish — web /login uchun 6 xonali kod',
  registered:
    'Rahmat! Raqamingiz qabul qilindi. Siz saytdan ro‘yxatdan o‘tdingiz.',
  contactRejected:
    'Faqat o‘zingizning Telegram raqamingizni yuboring. «Raqamni yuborish» tugmasidan foydalaning.',
  contactRequired:
    'Avval telefon raqamingizni yuboring. «Raqamni yuborish» tugmasini bosing.',
  registerFailed:
    'Ro‘yxatdan o‘tishda xatolik yuz berdi. Keyinroq qayta urinib ko‘ring.',
  phoneConflict:
    'Bu telefon raqami boshqa Telegram akkauntga bog‘langan.',
  noOrders: 'Hozircha buyurtmangiz yo‘q.',
  ordersHeader: '📦 Buyurtmalaringiz (oxirgi 10):\n',
  menuHint: 'Menyu har doim pastda.',
  codeSent: (code: string) => `Your code is <code>${code}</code>`,
  codeCooldown: 'Yangi kod uchun 10 daqiqa kuting.',
  codeFailed: 'Kod yuborib bo‘lmadi. Keyinroq qayta urinib ko‘ring.',
  openWebFailed: 'Open Web linkini yaratib bo‘lmadi. Qayta urinib ko‘ring.',
};

export const statusLabels: Record<string, string> = {
  pending: 'Kutilmoqda',
  paid: 'To‘langan',
  shipped: 'Jo‘natilgan',
  delivered: 'Yetkazilgan',
  cancelled: 'Bekor qilingan',
};
