// The tooltip on a booking card's sender domain says what was checked and nothing more: the
// message passed the mail server's sender check for that domain. It does not say the server
// confirmed who sent it, which the reader cannot know for mail handed in on the same server.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = join(__dirname, '..', '..', 'locales');
const langs = readdirSync(LOCALES).filter((lang) => existsSync(join(LOCALES, lang, 'common.json')));
const title = (lang: string) => JSON.parse(readFileSync(join(LOCALES, lang, 'common.json'), 'utf8')).sender_trust.card_sender_title as string;

/** The earlier wording, which said the mail server confirmed where the message comes from. */
const EARLIER: Record<string, string> = {
  "ar": "أكّد خادم البريد أن هذه الرسالة واردة من {domain}.",
  "ca": "El servidor de correu ha confirmat que aquest missatge ve de {domain}.",
  "cs": "Poštovní server ověřil, že tato zpráva pochází z {domain}.",
  "da": "Mailserveren har bekræftet, at denne besked kommer fra {domain}.",
  "de": "Der Mailserver hat bestätigt, dass diese Nachricht von {domain} kommt.",
  "el": "Ο διακομιστής αλληλογραφίας επιβεβαίωσε ότι αυτό το μήνυμα προέρχεται από {domain}.",
  "en": "The mail server confirmed that this message comes from {domain}.",
  "es": "El servidor de correo confirmó que este mensaje viene de {domain}.",
  "et": "Meiliserver kinnitas, et see kiri tuleb domeenilt {domain}.",
  "fa": "سرور ایمیل تأیید کرد که این پیام از {domain} آمده است.",
  "fr": "Le serveur de messagerie a confirmé que ce message provient de {domain}.",
  "he": "שרת הדואר אישר שההודעה הזו הגיעה מ-{domain}.",
  "hu": "A levelezőszerver megerősítette, hogy ez az üzenet innen érkezett: {domain}.",
  "it": "Il server di posta ha confermato che questo messaggio proviene da {domain}.",
  "ja": "メールサーバーは、このメッセージが {domain} から送信されたことを確認しました。",
  "ko": "메일 서버가 이 메시지가 {domain}에서 왔음을 확인했어요.",
  "lv": "Pasta serveris apstiprināja, ka šis ziņojums nāk no {domain}.",
  "mn": "Шуудангийн сервер энэ мессеж {domain}-с ирсэн болохыг баталгаажуулсан.",
  "nb": "E-postserveren har bekreftet at denne meldingen kommer fra {domain}.",
  "nl": "De mailserver heeft bevestigd dat dit bericht van {domain} komt.",
  "nn": "E-posttenaren har stadfesta at denne meldinga kjem frå {domain}.",
  "pl": "Serwer poczty potwierdził, że ta wiadomość pochodzi z {domain}.",
  "pt": "O servidor de email confirmou que esta mensagem vem de {domain}.",
  "ro": "Serverul de e-mail a confirmat că acest mesaj vine de la {domain}.",
  "ru": "Почтовый сервер подтвердил, что это сообщение пришло с {domain}.",
  "sk": "Poštový server overil, že táto správa pochádza z {domain}.",
  "th": "เซิร์ฟเวอร์อีเมลยืนยันแล้วว่าข้อความนี้มาจาก {domain}",
  "tr": "E-posta sunucusu bu iletinin {domain} alan adından geldiğini doğruladı.",
  "uk": "Поштовий сервер підтвердив, що це повідомлення надійшло з {domain}.",
  "vi": "Máy chủ thư đã xác nhận thư này đến từ {domain}.",
  "zh": "邮件服务器已确认此邮件来自 {domain}。",
  "zh-TW": "郵件伺服器已確認這封郵件來自 {domain}。"
};

describe('the tooltip of the sender domain on a booking card', () => {
  it('says in English that the message passed the sender check for the domain', () => {
    expect(title('en')).toBe("This message passed the mail server's sender check for {domain}.");
  });

  it.each(langs)('is reworded and translated in %s', (lang) => {
    const value = title(lang);
    expect(value).toContain('{domain}');
    expect(value).not.toBe(EARLIER[lang]);
    if (lang !== 'en') expect(value).not.toBe(title('en'));
    expect(value).not.toMatch(/\\u[0-9a-f]{4}/i);
  });

  it('covers every locale', () => {
    expect(langs.length).toBe(32);
    expect(Object.keys(EARLIER).sort()).toEqual([...langs].sort());
  });
});
