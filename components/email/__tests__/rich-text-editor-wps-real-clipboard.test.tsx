import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { RichTextEditor } from '../rich-text-editor';

const REAL = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=Generator content="Microsoft Excel">
<style>
<!--.font0
    {color:#000000;
    font-size:12.0pt;
    font-family:等线;
    font-weight:400;}
.font2
    {color:#FFFFFF;
    font-size:11.0pt;
    font-family:Calibri;
    font-weight:700;}
.font3
    {color:#FF0000;
    font-size:11.0pt;
    font-family:等线;
    font-weight:400;}
br
    {mso-data-placement:same-cell;}
td
    {padding-top:1px;
    padding-left:1px;
    padding-right:1px;
    mso-ignore:padding;
    color:#000000;
    font-size:12.0pt;
    font-weight:400;
    font-style:normal;
    text-decoration:none;
    font-family:等线;
    mso-generic-font-family:auto;
    mso-font-charset:134;
    mso-number-format:General;
    border:none;
    mso-background-source:auto;
    mso-pattern:auto;
    text-align:general;
    vertical-align:middle;
    white-space:nowrap;
    mso-rotate:0;
    mso-protection:locked visible;}
.et2
    {color:#000000;
    font-size:11.0pt;}
.et3
    {color:#FFFFFF;
    font-size:11.0pt;
    font-weight:700;
    font-family:Calibri;
    mso-generic-font-family:auto;
    mso-font-charset:134;
    border:.5pt solid #000000;
    background:#808080;
    mso-pattern:auto none;
    vertical-align:top;}
.et4
    {color:#000000;
    font-size:11.0pt;
    mso-generic-font-family:auto;
    mso-font-charset:134;
    border-top:none;
    border-right:.5pt solid #000000;
    border-bottom:.5pt solid #000000;
    border-left:none;
    vertical-align:top;
    white-space:normal;}
.et6
    {color:#000000;
    font-size:11.0pt;
    mso-generic-font-family:auto;
    mso-font-charset:134;
    border-top:none;
    border-right:.5pt solid #000000;
    border-bottom:.5pt solid #000000;
    border-left:none;
    background:#FFFF00;
    mso-pattern:auto none;
    vertical-align:top;
    white-space:normal;}
.et7
    {color:#FF0000;
    font-size:11.0pt;
    mso-generic-font-family:auto;
    mso-font-charset:134;
    border-top:none;
    border-right:.5pt solid #000000;
    border-bottom:.5pt solid #000000;
    border-left:none;
    vertical-align:top;
    white-space:normal;}
-->
</style>
</head>
<body>
<!--StartFragment-->
<table border=0 cellpadding=0 cellspacing=0 width=2371 height=121 style='border-collapse:collapse;width:2371.03pt;'>
 <col width=386 style='width:386.65pt;'>
 <col width=204 style='width:204.15pt;'>
 <tr height=19 style='height:19.00pt;'>
  <td class=et3 height=19 width=386 x:str style='height:19.00pt;width:386.65pt;'>请求标题</td>
  <td class=et3 width=204 x:str style='width:204.15pt;'>流程编号</td>
 </tr>
 <tr height=17 style='height:17.00pt;'>
  <td class=et4 height=17 width=386 x:str style='height:17.00pt;width:386.65pt;'>付款申请流程-张三-2026-07-24</td>
  <td class=et4 width=204 x:str style='width:204.15pt;'>PG-202601010001</td>
 </tr>
 <tr height=17 style='height:17.00pt;'>
  <td class=et6 height=17 width=386 x:str style='height:17.00pt;width:386.65pt;'>黄底行</td>
  <td class=et4 width=204 x:str style='width:204.15pt;'>PG-202601010002</td>
 </tr>
 <tr height=34 style='height:34.00pt;'>
  <td class=et7 height=34 width=386 x:str style='height:34.00pt;width:386.65pt;'>红字行</td>
  <td class=et4 width=204 x:str style='width:204.15pt;'>PG-202601010003</td>
 </tr>
</table>
<!--EndFragment-->
</body>
</html>`;

async function setup() {
  let editor: Editor | null = null;
  render(<RichTextEditor content="<p></p>" onChange={() => {}} onEditorReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

describe('real WPS clipboard', () => {
  it('keeps the colours', async () => {
    const editor = await setup();
    editor.view.pasteHTML(REAL, new Event('paste') as ClipboardEvent);
    const html = editor.getHTML();
    // white header text, yellow background, red text
    expect(html).toMatch(/255,\s*255,\s*255|#fff/i);
    expect(html).toMatch(/255,\s*0,\s*0|#ff0000/i);
    expect(html).toMatch(/255,\s*255,\s*0|#ffff00/i);
    editor.destroy();
  });
});
