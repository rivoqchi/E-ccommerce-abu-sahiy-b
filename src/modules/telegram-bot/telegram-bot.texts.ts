export const BTN_SHARE_PHONE = '📱 Raqamni yuborish';
export const BTN_MY_ORDERS = 'Buyurtmalarim';
export const BTN_SEND_CODE = 'Kod yuborish';
export const BTN_OPEN_WEB = 'Open Web';
export const BTN_MINI_APP = 'Mini App';
export const BTN_XITOY = 'Xitoy';

export const texts = {
  welcomeNeedPhone:
    'Assalomu alaykum! 👋\n\nRo‘yxatdan o‘tish Sami bot orqali. Telefon raqamingizni yuboring — pastdagi «Raqamni yuborish» tugmasini bosing.',
  registerGuideCaption:
    '1) Pastdagi «📱 Raqamni yuborish» tugmasini bosing.\n2) Keyin ochilgan oynada «OK» ni bosing.',
  welcomeReady:
    'Assalomu alaykum! 👋\n\nQuyidagi menyudan kerakli bo‘limni tanlang.\n\n• Open Web — sayt ochiladi va avtomatik kirasiz (kod shart emas)\n• Kod yuborish — web /login uchun 6 xonali kod',
  registered:
    'Rahmat! Raqamingiz qabul qilindi. Siz saytdan ro‘yxatdan o‘tdingiz.',
  waitingApproval:
    'Rahmat! Profilingiz qabul qilindi.\n\nAdmin tasdiqlashini kuting — shundan keyin Mini App, Kod yuborish, Open Web va Buyurtmalarim tugmalari ochiladi.',
  alreadyWaiting:
    'Profilingiz hali tasdiqlanmagan. Admin tasdiqlashini kuting.',
  blocked: 'Profilingiz bloklangan.',
  profileApproved:
    'Profilingiz tasdiqlandi. Quyidagi menyudan kerakli bo‘limni tanlang.\n\n• Open Web — sayt ochiladi va avtomatik kirasiz (kod shart emas)\n• Kod yuborish — web /login uchun 6 xonali kod',
  notAdmin: 'Faqat admin tasdiqlashi yoki bloklashi mumkin.',
  alreadyDecided: 'Bu profil allaqachon ko‘rib chiqilgan.',
  excelSeenOk: 'Ko‘rdi deb belgilandi',
  excelSeenAlready: 'Allaqachon belgilangansiz',
  approvedBy: (name: string) => `${name} tasdiqlagan`,
  blockedBy: (name: string) => `${name} bloklagan`,
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
  xitoyAdminOnly: 'Bu bo‘lim faqat adminlar uchun.',
  xitoyStarted:
    'Xitoy mahsulot qo‘shish boshlandi.\n\nRasm yuboring yoki /bekor bilan bekor qiling.',
  xitoyCancelled: 'Qo‘shish bekor qilindi.',
  xitoyInvalidNumber: 'Noto‘g‘ri raqam. Iltimos, musbat son kiriting.',
  xitoyInvalidName: 'Nom bo‘sh bo‘lmasligi kerak.',
  xitoyNeedPhoto: 'Avval rasm yuboring.',
  xitoyPhotoFailed: 'Rasm saqlanmadi. Qayta urinib ko‘ring.',
  xitoySuccess: (name: string) =>
    `✅ «${name}» muvaffaqiyatli qo‘shildi!`,
};

export const statusLabels: Record<string, string> = {
  pending: 'Kutilmoqda',
  paid: 'To‘langan',
  shipped: 'Jo‘natilgan',
  delivered: 'Yetkazilgan',
  cancelled: 'Bekor qilingan',
};
