/**
 * Content height of a mail body rendered in an auto-sized iframe.
 *
 * The root element's scrollHeight never drops below the frame's own height:
 * it is the larger of the content and the viewport. Sizing the frame from it
 * alone is a ratchet. Once the frame has been tall, it can't shrink again, so
 * any mail that gets shorter after the first measurement keeps a blank area
 * of its old height under the text (#1474). That happens when the frame is
 * first laid out narrower than it ends up (the phone reader sliding in), when
 * a quote is expanded and folded again, or when broken images are hidden.
 *
 * When the root reports more than the viewport, that is real overflow and it
 * is used as is. When it reports exactly the viewport, the content may be
 * shorter, so the body's own box decides.
 */
export function measureEmailFrameHeight(doc: Document): number {
  const root = doc.documentElement;
  const body = doc.body;
  const rootHeight = root.scrollHeight;
  const bodyHeight = body.scrollHeight;
  // 1px of slack for sub-pixel rounding.
  if (rootHeight > root.clientHeight + 1) return Math.max(rootHeight, bodyHeight);

  const view = doc.defaultView;
  const bodyStyle = view?.getComputedStyle(body);
  const rootStyle = view?.getComputedStyle(root);
  const px = (value: string | undefined) => parseFloat(value ?? '') || 0;
  const bodyBottom = body.getBoundingClientRect().bottom
    + (view?.scrollY ?? 0)
    + px(bodyStyle?.marginBottom)
    + px(rootStyle?.paddingBottom)
    + px(rootStyle?.borderBottomWidth);
  return Math.ceil(Math.max(bodyHeight, bodyBottom));
}
