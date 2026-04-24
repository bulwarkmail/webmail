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

/** Map locale codes to flag components */
export const flagComponents: Record<string, (props: FlagProps) => ReactElement> = {
  en: FlagGB,
  fr: FlagFR,
  ja: FlagJP,
  ko: FlagKR,
  es: FlagES,
  it: FlagIT,
  de: FlagDE,
  lv: FlagLV,
  nl: FlagNL,
  pl: FlagPL,
  pt: FlagBR,
  ru: FlagRU,
  uk: FlagUA,
  zh: FlagCN,
};
