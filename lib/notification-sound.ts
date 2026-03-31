import { debug } from '@/lib/debug';

export type NotificationSoundChoice = 'default' | 'cheerful' | 'involved' | 'swift' | 'relax';

export const NOTIFICATION_SOUNDS: { id: NotificationSoundChoice; file?: string }[] = [
  { id: 'default' },
  { id: 'cheerful', file: '/notification/cheerful-527.mp3' },
  { id: 'involved', file: '/notification/involved-notification.mp3' },
  { id: 'swift', file: '/notification/notification-tone-swift-gesture.mp3' },
  { id: 'relax', file: '/notification/relax-message-tone.mp3' },
];

function playBeep() {
  const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.frequency.value = 800;
  oscillator.type = 'sine';
  gainNode.gain.value = 0.1;

  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.15);
  oscillator.onended = () => audioContext.close();
}

function playFile(file: string) {
  const audio = new Audio(file);
  audio.volume = 0.3;
  audio.play().catch((e) => {
    debug.log('push', 'Could not play audio file, falling back to beep:', e);
    playBeep();
  });
}

export function playNotificationSound(sound?: NotificationSoundChoice) {
  try {
    const choice = sound ?? 'default';
    const entry = NOTIFICATION_SOUNDS.find((s) => s.id === choice);

    if (entry?.file) {
      playFile(entry.file);
    } else {
      playBeep();
    }
  } catch (e) {
    debug.log('push', 'Could not play notification sound:', e);
  }
}
