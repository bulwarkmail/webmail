import { Fragment } from "react";
import { addressBreakPieces } from "@/lib/text-breaks";

/** An address that wraps at its dots and after its @, not anywhere (lib/text-breaks.ts). */
export function BreakableAddress({ text }: { text: string }) {
  const pieces = addressBreakPieces(text);
  return (
    <>
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {piece}
        </Fragment>
      ))}
    </>
  );
}
