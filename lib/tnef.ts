/**
 * Minimal TNEF (Transport Neutral Encapsulation Format) parser.
 *
 * Parses winmail.dat files sent by Microsoft Outlook to extract
 * the HTML body, plain text body, and embedded attachments.
 *
 * Reference: MS-OXTNEF / MS-TNEF specification.
 */

import { debug } from '@/lib/debug';

// TNEF signature
const TNEF_SIGNATURE = 0x223E9F78;

// Attribute levels
const LVL_MESSAGE = 0x01;
const LVL_ATTACHMENT = 0x02;

// Message-level attribute IDs
const attBody = 0x0002800C;
const attMAPIProps = 0x00069003;

// Attachment-level attribute IDs
const attAttachRenddata = 0x00069002;
const attAttachData = 0x0006800F;
const attAttachTitle = 0x00018010;
const attAttachment = 0x00069005; // MAPI props for attachments

// MAPI property types
const PT_SHORT = 0x0002;
const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000B;
const PT_STRING8 = 0x001E;
const PT_UNICODE = 0x001F;
const PT_BINARY = 0x0102;
const PT_SYSTIME = 0x0040;
const PT_CLSID = 0x0048;
const PT_I8 = 0x0014;

// Multi-value flag
const MV_FLAG = 0x1000;

// MAPI property IDs
const PR_BODY = 0x1000;
const PR_BODY_HTML = 0x1013;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370E;
const PR_ATTACH_DATA_BIN = 0x3701;

export interface TnefAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface TnefResult {
  body: string | null;
  htmlBody: string | null;
  attachments: TnefAttachment[];
}

class BinaryReader {
  private view: DataView;
  private offset: number;
  private bytes: Uint8Array;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = 0;
  }

  readUint8(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readUint16LE(): number {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readUint32LE(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readBytes(length: number): Uint8Array {
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  skip(n: number): void {
    this.offset += n;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }
}

/** Padding needed to align to 4-byte boundary */
function pad4(len: number): number {
  return (4 - (len % 4)) % 4;
}

/** Read a single MAPI property value (fixed-length types only) */
function readMAPIFixedValue(r: BinaryReader, propType: number): Uint8Array | number | null {
  switch (propType) {
    case PT_SHORT: {
      const val = r.readUint16LE();
      r.skip(2); // padded to 4 bytes
      return val;
    }
    case PT_LONG:
    case PT_BOOLEAN:
      return r.readUint32LE();
    case PT_I8:
    case PT_SYSTIME:
      return r.readBytes(8);
    case PT_CLSID:
      return r.readBytes(16);
    default:
      // Unknown/unsupported type - try to read as fixed 4 bytes
      if (r.remaining >= 4) {
        return r.readBytes(4);
      }
      return null;
  }
}

/** Read a variable-length MAPI value (length-prefixed with padding) */
function readMAPIVarValue(r: BinaryReader): Uint8Array | null {
  if (r.remaining < 4) return null;
  const length = r.readUint32LE();
  if (length > r.remaining) return null;
  const data = r.readBytes(length);
  r.skip(pad4(length));
  return data;
}

/** Check if a base property type is variable-length */
function isVarLengthType(baseType: number): boolean {
  return baseType === PT_STRING8 || baseType === PT_UNICODE || baseType === PT_BINARY;
}

/** Decode a MAPI string (PT_STRING8 or PT_UNICODE) from raw bytes */
function decodeMAPIString(data: Uint8Array, propType: number): string {
  if (propType === PT_UNICODE) {
    let len = data.byteLength;
    // Strip null terminator (2 bytes for UTF-16)
    if (len >= 2 && data[len - 1] === 0 && data[len - 2] === 0) {
      len -= 2;
    }
    return new TextDecoder('utf-16le').decode(data.subarray(0, len));
  }
  let len = data.byteLength;
  if (len >= 1 && data[len - 1] === 0) {
    len -= 1;
  }
  return new TextDecoder('utf-8').decode(data.subarray(0, len));
}

/** Parse MAPI properties from a raw attribute data block */
function parseMAPIProps(data: Uint8Array): Map<number, { type: number; value: Uint8Array | number | null }> {
  const props = new Map<number, { type: number; value: Uint8Array | number | null }>();
  const r = new BinaryReader(data);

  if (r.remaining < 4) return props;
  const count = r.readUint32LE();

  for (let i = 0; i < count && r.remaining >= 4; i++) {
    const propType = r.readUint16LE();
    const propID = r.readUint16LE();

    // Named properties (ID >= 0x8000) carry extra GUID + name data
    if (propID >= 0x8000) {
      if (r.remaining < 20) break;
      r.skip(16); // GUID
      const kind = r.readUint32LE();
      if (kind === 0) {
        if (r.remaining < 4) break;
        r.skip(4); // named-by-ID
      } else {
        if (r.remaining < 4) break;
        const nameLen = r.readUint32LE();
        if (nameLen > r.remaining) break;
        r.skip(nameLen);
        r.skip(pad4(nameLen));
      }
    }

    const baseType = propType & 0x0FFF;
    const isMultiValue = (propType & MV_FLAG) !== 0;

    if (isVarLengthType(baseType)) {
      // Variable-length types always have a value count (1 for single-value)
      if (r.remaining < 4) break;
      const valueCount = r.readUint32LE();
      let lastValue: Uint8Array | null = null;
      for (let j = 0; j < valueCount && r.remaining > 0; j++) {
        lastValue = readMAPIVarValue(r);
      }
      if (!isMultiValue && lastValue) {
        props.set(propID, { type: propType, value: lastValue });
      }
    } else if (isMultiValue) {
      if (r.remaining < 4) break;
      const valueCount = r.readUint32LE();
      for (let j = 0; j < valueCount && r.remaining > 0; j++) {
        readMAPIFixedValue(r, baseType);
      }
    } else {
      const value = readMAPIFixedValue(r, baseType);
      props.set(propID, { type: propType, value });
    }
  }

  return props;
}

/**
 * Parse a TNEF (winmail.dat) file and extract the body and attachments.
 *
 * @param data - Raw bytes of the TNEF file
 * @returns Parsed result with body text, HTML body, and attachments
 */
export function parseTnef(data: Uint8Array): TnefResult {
  const result: TnefResult = {
    body: null,
    htmlBody: null,
    attachments: [],
  };

  debug.group('TNEF Parser', 'email');
  debug.log('email', 'Input data size:', data.byteLength, 'bytes');

  if (data.byteLength < 6) {
    debug.warn('email', 'TNEF data too small (< 6 bytes), skipping');
    debug.groupEnd();
    return result;
  }

  const r = new BinaryReader(data);

  const signature = r.readUint32LE();
  if (signature !== TNEF_SIGNATURE) {
    debug.warn('email', 'Invalid TNEF signature:', '0x' + signature.toString(16).toUpperCase(), '(expected 0x223E9F78)');
    debug.groupEnd();
    return result;
  }
  debug.log('email', 'TNEF signature valid');

  r.skip(2); // legacy key

  // Current attachment being assembled
  let curAttach: { name: string; mimeType: string; data: Uint8Array | null } | null = null;
  let attrCount = 0;

  while (r.remaining >= 11) {
    const level = r.readUint8();
    const attrID = r.readUint32LE();
    const attrLen = r.readUint32LE();
    attrCount++;

    if (attrLen > r.remaining - 2) {
      debug.warn('email', 'Attribute #' + attrCount + ': truncated data - need', attrLen, 'bytes but only', r.remaining - 2, 'available');
      break;
    }

    const attrData = r.readBytes(attrLen);
    r.skip(2); // checksum

    const levelName = level === LVL_MESSAGE ? 'MESSAGE' : level === LVL_ATTACHMENT ? 'ATTACHMENT' : 'UNKNOWN(' + level + ')';
    debug.log('email', 'Attribute #' + attrCount + ':', levelName, 'id=0x' + attrID.toString(16).toUpperCase(), 'len=' + attrLen);

    if (level === LVL_MESSAGE) {
      if (attrID === attBody) {
        result.body = new TextDecoder('utf-8').decode(attrData);
        debug.log('email', '  → Extracted plain text body (' + result.body.length + ' chars)');
      } else if (attrID === attMAPIProps) {
        const props = parseMAPIProps(attrData);
        debug.log('email', '  → Parsed', props.size, 'MAPI properties from message');
        props.forEach((val, propID) => {
          debug.log('email', '    MAPI prop 0x' + propID.toString(16).toUpperCase(), 'type=0x' + val.type.toString(16), 'value=' + (val.value instanceof Uint8Array ? val.value.byteLength + ' bytes' : val.value));
        });

        // HTML body
        const htmlProp = props.get(PR_BODY_HTML);
        if (htmlProp?.value instanceof Uint8Array) {
          const baseType = htmlProp.type & 0x0FFF;
          if (baseType === PT_STRING8 || baseType === PT_UNICODE) {
            result.htmlBody = decodeMAPIString(htmlProp.value, baseType);
          } else {
            result.htmlBody = new TextDecoder('utf-8').decode(htmlProp.value);
          }
          debug.log('email', '  → Extracted HTML body (' + result.htmlBody.length + ' chars)');
        } else {
          debug.log('email', '  → No HTML body property (PR_BODY_HTML 0x1013) found in MAPI props');
        }

        // Plain text body from MAPI props (fallback)
        if (!result.body) {
          const bodyProp = props.get(PR_BODY);
          if (bodyProp?.value instanceof Uint8Array) {
            result.body = decodeMAPIString(bodyProp.value, bodyProp.type & 0x0FFF);
            debug.log('email', '  → Extracted plain text body from MAPI props (' + result.body.length + ' chars)');
          } else {
            debug.log('email', '  → No plain text body property (PR_BODY 0x1000) found in MAPI props');
          }
        }
      }
    } else if (level === LVL_ATTACHMENT) {
      if (attrID === attAttachRenddata) {
        // Start of a new attachment - flush previous
        if (curAttach?.data) {
          debug.log('email', '  → Flushing previous attachment:', curAttach.name, '(' + curAttach.mimeType + ',', curAttach.data.byteLength, 'bytes)');
          result.attachments.push({
            name: curAttach.name,
            mimeType: curAttach.mimeType,
            data: curAttach.data,
          });
        }
        curAttach = { name: 'attachment', mimeType: 'application/octet-stream', data: null };
        debug.log('email', '  → New attachment started');
      } else if (attrID === attAttachTitle && curAttach) {
        let len = attrData.byteLength;
        if (len > 0 && attrData[len - 1] === 0) len--;
        curAttach.name = new TextDecoder('utf-8').decode(attrData.subarray(0, len));
        debug.log('email', '  → Attachment short name:', curAttach.name);
      } else if (attrID === attAttachData && curAttach) {
        curAttach.data = attrData;
        debug.log('email', '  → Attachment data (attAttachData):', attrData.byteLength, 'bytes');
      } else if (attrID === attAttachment && curAttach) {
        const props = parseMAPIProps(attrData);
        debug.log('email', '  → Parsed', props.size, 'MAPI properties from attachment');
        props.forEach((val, propID) => {
          debug.log('email', '    MAPI prop 0x' + propID.toString(16).toUpperCase(), 'type=0x' + val.type.toString(16), 'value=' + (val.value instanceof Uint8Array ? val.value.byteLength + ' bytes' : val.value));
        });

        const longName = props.get(PR_ATTACH_LONG_FILENAME);
        if (longName?.value instanceof Uint8Array) {
          curAttach.name = decodeMAPIString(longName.value, longName.type & 0x0FFF);
          debug.log('email', '  → Attachment long filename:', curAttach.name);
        }

        const mimeTag = props.get(PR_ATTACH_MIME_TAG);
        if (mimeTag?.value instanceof Uint8Array) {
          curAttach.mimeType = decodeMAPIString(mimeTag.value, mimeTag.type & 0x0FFF);
          debug.log('email', '  → Attachment MIME type:', curAttach.mimeType);
        }

        const attachData = props.get(PR_ATTACH_DATA_BIN);
        if (attachData?.value instanceof Uint8Array) {
          curAttach.data = attachData.value;
          debug.log('email', '  → Attachment data (PR_ATTACH_DATA_BIN):', attachData.value.byteLength, 'bytes');
        } else {
          debug.log('email', '  → No PR_ATTACH_DATA_BIN found in attachment MAPI props');
        }
      }
    }
  }

  // Flush last attachment
  if (curAttach?.data) {
    debug.log('email', 'Flushing final attachment:', curAttach.name, '(' + curAttach.mimeType + ',', curAttach.data.byteLength, 'bytes)');
    result.attachments.push({
      name: curAttach.name,
      mimeType: curAttach.mimeType,
      data: curAttach.data,
    });
  }

  debug.log('email', 'TNEF parsing complete - body:', !!result.body, ', htmlBody:', !!result.htmlBody, ', attachments:', result.attachments.length);
  if (result.attachments.length > 0) {
    debug.table(result.attachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.data.byteLength })), 'email');
  }
  debug.groupEnd();

  return result;
}

/**
 * Check if a MIME attachment is a TNEF (winmail.dat) file.
 */
export function isTnefAttachment(name?: string | null, type?: string): boolean {
  const lowerName = (name || '').toLowerCase();
  const lowerType = (type || '').toLowerCase();
  return (
    lowerName === 'winmail.dat' ||
    lowerType === 'application/ms-tnef' ||
    lowerType === 'application/vnd.ms-tnef'
  );
}
