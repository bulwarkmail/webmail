import { type SVGProps, type ReactElement } from "react";

type FlagProps = SVGProps<SVGSVGElement>;

const flagClass = "inline-block rounded-[2px] shrink-0";
const W = 20;
const H = 15;

/** Great Britain – Union Jack (simplified) */
export function FlagGB(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30" width={W} height={H} className={flagClass} {...props}>
      <rect width="60" height="30" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="2" />
      <path d="M30,0 V30 M0,15 H60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}

/** France – Blue, White, Red vertical */
export function FlagFR(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="1" height="2" fill="#002395" />
      <rect x="1" width="1" height="2" fill="#fff" />
      <rect x="2" width="1" height="2" fill="#ED2939" />
    </svg>
  );
}

/** Japan – White with red circle */
export function FlagJP(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="3" height="2" fill="#fff" />
      <circle cx="1.5" cy="1" r="0.6" fill="#BC002D" />
    </svg>
  );
}

/** South Korea – Simplified */
export function FlagKR(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="3" height="2" fill="#fff" />
      <path d="M1.5 0.5 a0.45 0.45 0 1 1 0 0.9 a0.45 0.45 0 1 0 0 -0.9" fill="#CD2E3A" />
      <path d="M1.5 1.5 a0.45 0.45 0 1 1 0 -0.9 a0.45 0.45 0 1 0 0 0.9" fill="#0047A0" />
      <circle cx="1.5" cy="0.8" r="0.225" fill="#0047A0" />
      <circle cx="1.5" cy="1.2" r="0.225" fill="#CD2E3A" />
      <g stroke="#000" strokeWidth="0.06" strokeLinecap="round">
        <line x1="0.42" y1="0.35" x2="0.78" y2="0.35" />
        <line x1="0.42" y1="0.46" x2="0.78" y2="0.46" />
        <line x1="0.42" y1="0.57" x2="0.78" y2="0.57" />
        <line x1="2.22" y1="0.35" x2="2.58" y2="0.35" />
        <line x1="2.22" y1="0.57" x2="2.58" y2="0.57" />
        <line x1="0.42" y1="1.43" x2="0.78" y2="1.43" />
        <line x1="0.42" y1="1.65" x2="0.78" y2="1.65" />
        <line x1="2.22" y1="1.43" x2="2.58" y2="1.43" />
        <line x1="2.22" y1="1.54" x2="2.58" y2="1.54" />
        <line x1="2.22" y1="1.65" x2="2.58" y2="1.65" />
      </g>
    </svg>
  );
}

/** Spain – Red, Yellow, Red horizontal */
export function FlagES(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="3" height="0.5" fill="#AA151B" />
      <rect y="0.5" width="3" height="1" fill="#F1BF00" />
      <rect y="1.5" width="3" height="0.5" fill="#AA151B" />
    </svg>
  );
}

/** Italy – Green, White, Red vertical */
export function FlagIT(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="1" height="2" fill="#009246" />
      <rect x="1" width="1" height="2" fill="#fff" />
      <rect x="2" width="1" height="2" fill="#CE2B37" />
    </svg>
  );
}

/** Germany – Black, Red, Gold horizontal */
export function FlagDE(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 3" width={W} height={H} className={flagClass} {...props}>
      <rect width="5" height="1" fill="#000" />
      <rect y="1" width="5" height="1" fill="#DD0000" />
      <rect y="2" width="5" height="1" fill="#FFCC00" />
    </svg>
  );
}

/** Hungary – Red, White, Green horizontal */
export function FlagHU(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 3" width={W} height={H} className={flagClass} {...props}>
      <rect width="6" height="1" fill="#CD2A3E" />
      <rect y="1" width="6" height="1" fill="#fff" />
      <rect y="2" width="6" height="1" fill="#436F4D" />
    </svg>
  );
}

/** Latvia – Maroon, White, Maroon horizontal */
export function FlagLV(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" width={W} height={H} className={flagClass} {...props}>
      <rect width="20" height="4" fill="#9E3039" />
      <rect y="4" width="20" height="2" fill="#fff" />
      <rect y="6" width="20" height="4" fill="#9E3039" />
    </svg>
  );
}

/** Netherlands – Red, White, Blue horizontal */
export function FlagNL(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 6" width={W} height={H} className={flagClass} {...props}>
      <rect width="9" height="2" fill="#AE1C28" />
      <rect y="2" width="9" height="2" fill="#fff" />
      <rect y="4" width="9" height="2" fill="#21468B" />
    </svg>
  );
}

/** Poland – White, Red horizontal */
export function FlagPL(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 5" width={W} height={H} className={flagClass} {...props}>
      <rect width="8" height="2.5" fill="#fff" />
      <rect y="2.5" width="8" height="2.5" fill="#DC143C" />
    </svg>
  );
}

/** Brazil – Green, yellow diamond (simplified) */
export function FlagBR(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 14" width={W} height={H} className={flagClass} {...props}>
      <rect width="20" height="14" fill="#009B3A" />
      <polygon points="10,1.5 18.5,7 10,12.5 1.5,7" fill="#FEDF00" />
      <circle cx="10" cy="7" r="3" fill="#002776" />
    </svg>
  );
}

/** Russia – White, Blue, Red horizontal */
export function FlagRU(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 6" width={W} height={H} className={flagClass} {...props}>
      <rect width="9" height="2" fill="#fff" />
      <rect y="2" width="9" height="2" fill="#0039A6" />
      <rect y="4" width="9" height="2" fill="#D52B1E" />
    </svg>
  );
}

/** Turkey - Red with white crescent and star */
export function FlagTR(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width={W} height={H} className={flagClass} {...props}>
      <rect width="30" height="20" fill="#E30A17" />
      <circle cx="10" cy="10" r="6" fill="#fff" />
      <circle cx="11.5" cy="10" r="5" fill="#E30A17" />
      <polygon points="19.5,7.8 19.994,9.32 21.592,9.32 20.299,10.26 20.793,11.78 19.5,10.84 18.207,11.78 18.701,10.26 17.408,9.32 19.006,9.32" fill="#fff" />
    </svg>
  );
}

/** Ukraine – Blue, Yellow horizontal */
export function FlagUA(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="3" height="1" fill="#005BBB" />
      <rect y="1" width="3" height="1" fill="#FFD500" />
    </svg>
  );
}

/** China – Red with yellow stars (simplified) */
export function FlagCN(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width={W} height={H} className={flagClass} {...props}>
      <rect width="30" height="20" fill="#DE2910" />
      <g fill="#FFDE00">
        <polygon points="5,2 6,5 3.2,3.2 6.8,3.2 4,5" />
        <polygon points="10,1 10.6,2.7 9,1.8 11,1.8 9.4,2.7" />
        <polygon points="12,3 12.6,4.7 11,3.8 13,3.8 11.4,4.7" />
        <polygon points="12,6 12.6,7.7 11,6.8 13,6.8 11.4,7.7" />
        <polygon points="10,8 10.6,9.7 9,8.8 11,8.8 9.4,9.7" />
      </g>
    </svg>
  );
}

/** Czech Republic - White and red horizontal bands with a blue triangle */
export function FlagCS(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="3" height="2" fill="#fff" />
      <rect y="1" width="3" height="1" fill="#D7141A" />
      <polygon points="0,0 1.5,1 0,2" fill="#11457E" />
    </svg>
  );
}

/** Denmark – Red with a white Nordic cross */
export function FlagDK(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 28" width={W} height={H} className={flagClass} {...props}>
      <path fill="#C8102E" d="M0,0H37V28H0Z" />
      <path stroke="#fff" strokeWidth="4" d="M0,14h37M14,0v28" />
    </svg>
  );
}

/** Romania – Vertical blue, yellow, red tricolour */
export function FlagRO(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" width={W} height={H} className={flagClass} {...props}>
      <rect width="1" height="2" fill="#002B7F" />
      <rect x="1" width="1" height="2" fill="#FCD116" />
      <rect x="2" width="1" height="2" fill="#CE1126" />
    </svg>
  );
}

/** Iran – Green, White, Red horizontal with emblem (simplified) */
export function FlagIR(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3" width={W} height={H} className={flagClass} {...props}>
      <rect width="4" height="1" fill="#239F40" />
      <rect y="1" width="4" height="1" fill="#fff" />
      <rect y="2" width="4" height="1" fill="#DA0000" />
      <circle cx="2" cy="1.5" r="0.3" fill="#DA0000" />
    </svg>
  );
}

const skShield =
  "m269.993 459.98-3.906-1.867c-25.267-12.173-56.294-30.4-81.294-58.133" +
  "-25-27.733-43.8-65.307-43.8-114.24 0-93.6 4.52-136.68 4.52-136.68" +
  "l.84-8.067h247.28l.84 8.067s4.534 43.093 4.534 136.68" +
  "c0 48.933-18.8 86.507-43.814 114.24-25 27.733-56.026 45.96-81.293 58.133Z";
const skCross =
  "M280.56 261.28c13.36.22 39.45.74 62.67-7.03 0 0-.61 8.31-.61 17.99" +
  " 0 9.67.61 17.98.61 17.98-21.3-7.12-47.61-7.27-62.67-7.08v51.54h-21.12" +
  "v-51.54c-15.07-.2-41.37-.04-62.68 7.08 0 0 .62-8.3.62-17.98s-.62-17.99" +
  "-.62-17.99c23.23 7.77 49.31 7.25 62.68 7.03v-32.37c-12.19-.1-29.74.48" +
  "-49.6 7.12 0 0 .62-8.3.62-17.98s-.62-17.98-.62-17.98c19.83 6.62 37.36" +
  " 7.22 49.54 7.11-.62-20.5-6.6-46.33-6.6-46.33s12.3.96 17.22.96c4.92 0" +
  " 17.21-.96 17.21-.96s-5.97 25.83-6.6 46.33c12.18.1 29.72-.49 49.55-7.11" +
  " 0 0-.62 8.3-.62 17.98 0 9.67.62 17.98.62 17.98-19.86-6.64-37.42-7.22-49.6-7.12v32.37";
const skHills =
  "M270 329.1c-24.87 0-38.19 34.46-38.19 34.46s-7.4-16.34-27.68-16.34" +
  "c-13.73 0-23.82 12.2-30.25 23.5 24.97 39.7 64.8 64.2 96.11 79.28" +
  " 31.32-15.07 71.16-39.58 96.13-79.28-6.43-11.3-16.52-23.5-30.25-23.5" +
  "a30.52 30.52 0 0 0-27.69 16.34s-13.32-34.46-38.19-34.46Z";

/** Slovakia – White, Blue, Red horizontal with coat of arms */
export function FlagSK(props: FlagProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" width={W} height={H} className={flagClass} {...props}>
      <path fill="#fff" d="M0 200h900V0H0Z" />
      <path fill="#254aa5" d="M0 400h900V200H0Z" />
      <path fill="#ed1c24" d="M0 600h900V400H0Z" />
      <path fill="#fff" d={skShield} />
      <path fill="#ed1c24" d="M270 450c-49.38-23.76-120-70.94-120-164.25S154.46 150 154.46 150h231.07S390 192.44 390 285.75 319.37 426.24 270 450" />
      <path fill="#fff" d={skCross} />
      <path fill="#254aa5" d={skHills} />
    </svg>
  );
}


export const flagComponents: Record<string, (props: FlagProps) => ReactElement> = {
  cs: FlagCS,
  sk: FlagSK,
  da: FlagDK,
  de: FlagDE,
  en: FlagGB,
  es: FlagES,
  fr: FlagFR,
  hu: FlagHU,
  it: FlagIT,
  ja: FlagJP,
  ko: FlagKR,
  lv: FlagLV,
  nl: FlagNL,
  pl: FlagPL,
  pt: FlagBR,
  ro: FlagRO,
  ru: FlagRU,
  tr: FlagTR,
  uk: FlagUA,
  zh: FlagCN,
  fa: FlagIR,
};
