import { NextRequest, NextResponse } from 'next/server';

// In-memory LRU cache: domain -> { data, contentType, fetchedAt }
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}

interface NegativeCacheEntry {
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, NegativeCacheEntry>();
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const NEGATIVE_CACHE_MAX_SIZE = 2000;

// 1x1 transparent PNG. Returned with HTTP 200 (instead of 404) when no
// favicon exists for a domain, so the browser's <img> tag loads it cleanly
// without spamming the DevTools console with red 404 errors. Avatar.tsx
// checks `naturalWidth <= 1` in onLoad and falls back to initials.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
);
const MISSING_FAVICON_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400', // 1 day
  'X-Bulwark-Favicon': 'missing',
};

// Strict domain validation to prevent SSRF
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  if (!DOMAIN_RE.test(domain)) return false;
  // Block internal/private hostnames
  const lower = domain.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    return false;
  }
  return true;
}

// Known multi-part TLDs where the registrable domain includes one extra label.
const MULTI_PART_TLDS = new Set([
  // .ac
  "com.ac", "gov.ac", "mil.ac", "net.ac", "org.ac",
  // .ae
  "ac.ae", "co.ae", "gov.ae", "mil.ae", "name.ae", "net.ae", "org.ae", "pro.ae", "sch.ae",
  // .af
  "com.af", "edu.af", "gov.af", "net.af", "org.af",
  // .al
  "com.al", "edu.al", "gov.al", "mil.al", "net.al", "org.al",
  // .ao
  "co.ao", "ed.ao", "gv.ao", "it.ao", "og.ao", "pb.ao",
  // .ar
  "com.ar", "edu.ar", "gob.ar", "gov.ar", "int.ar", "mil.ar", "net.ar", "org.ar", "tur.ar",
  // .at
  "ac.at", "co.at", "gv.at", "or.at",
  // .au
  "asn.au", "com.au", "csiro.au", "edu.au", "gov.au", "id.au", "net.au", "org.au",
  // .ba
  "co.ba", "com.ba", "edu.ba", "gov.ba", "mil.ba", "net.ba", "org.ba", "rs.ba",
  "unbi.ba", "unmo.ba", "unsa.ba", "untz.ba", "unze.ba",
  // .bb
  "biz.bb", "co.bb", "com.bb", "edu.bb", "gov.bb", "info.bb", "net.bb", "org.bb",
  "store.bb", "tv.bb",
  // .bh
  "biz.bh", "cc.bh", "com.bh", "edu.bh", "gov.bh", "info.bh", "net.bh", "org.bh",
  // .bn
  "com.bn", "edu.bn", "gov.bn", "net.bn", "org.bn",
  // .bo
  "com.bo", "edu.bo", "gob.bo", "gov.bo", "int.bo", "mil.bo", "net.bo", "org.bo", "tv.bo",
  // .br
  "adm.br", "adv.br", "agr.br", "am.br", "arq.br", "art.br", "ato.br", "b.br",
  "bio.br", "blog.br", "bmd.br", "cim.br", "cng.br", "cnt.br", "com.br", "coop.br",
  "ecn.br", "edu.br", "eng.br", "esp.br", "etc.br", "eti.br", "far.br", "flog.br",
  "fm.br", "fnd.br", "fot.br", "fst.br", "g12.br", "ggf.br", "gov.br", "imb.br",
  "ind.br", "inf.br", "jor.br", "jus.br", "lel.br", "mat.br", "med.br", "mil.br",
  "mus.br", "net.br", "nom.br", "not.br", "ntr.br", "odo.br", "org.br", "ppg.br",
  "pro.br", "psc.br", "psi.br", "qsl.br", "rec.br", "slg.br", "srv.br", "tmp.br",
  "trd.br", "tur.br", "tv.br", "vet.br", "vlog.br", "wiki.br", "zlg.br",
  // .bs
  "com.bs", "edu.bs", "gov.bs", "net.bs", "org.bs",
  // .bz
  "com.bz", "edu.bz", "gov.bz", "net.bz", "org.bz",
  // .ca
  "ab.ca", "bc.ca", "mb.ca", "nb.ca", "nf.ca", "nl.ca", "ns.ca", "nt.ca",
  "nu.ca", "on.ca", "pe.ca", "qc.ca", "sk.ca", "yk.ca",
  // .ck
  "biz.ck", "co.ck", "edu.ck", "gen.ck", "gov.ck", "info.ck", "net.ck", "org.ck",
  // .cn
  "ac.cn", "ah.cn", "bj.cn", "com.cn", "cq.cn", "edu.cn", "fj.cn", "gd.cn",
  "gov.cn", "gs.cn", "gx.cn", "gz.cn", "ha.cn", "hb.cn", "he.cn", "hi.cn",
  "hl.cn", "hn.cn", "jl.cn", "js.cn", "jx.cn", "ln.cn", "mil.cn", "net.cn",
  "nm.cn", "nx.cn", "org.cn", "qh.cn", "sc.cn", "sd.cn", "sh.cn", "sn.cn",
  "sx.cn", "tj.cn", "tw.cn", "xj.cn", "xz.cn", "yn.cn", "zj.cn",
  // .co
  "com.co", "edu.co", "gov.co", "mil.co", "net.co", "nom.co", "org.co",
  // .cr
  "ac.cr", "co.cr", "ed.cr", "fi.cr", "go.cr", "or.cr", "sa.cr",
  // .cy
  "ac.cy", "biz.cy", "com.cy", "ekloges.cy", "gov.cy", "ltd.cy", "name.cy",
  "net.cy", "org.cy", "parliament.cy", "press.cy", "pro.cy", "tm.cy",
  // .do
  "art.do", "com.do", "edu.do", "gob.do", "gov.do", "mil.do", "net.do", "org.do",
  "sld.do", "web.do",
  // .dz
  "art.dz", "asso.dz", "com.dz", "edu.dz", "gov.dz", "net.dz", "org.dz", "pol.dz",
  // .ec
  "com.ec", "edu.ec", "fin.ec", "gov.ec", "info.ec", "med.ec", "mil.ec", "net.ec",
  "org.ec", "pro.ec",
  // .eg
  "com.eg", "edu.eg", "eun.eg", "gov.eg", "mil.eg", "name.eg", "net.eg", "org.eg", "sci.eg",
  // .er
  "com.er", "edu.er", "gov.er", "ind.er", "mil.er", "net.er", "org.er", "rochest.er", "w.er",
  // .es
  "com.es", "edu.es", "gob.es", "nom.es", "org.es",
  // .et
  "biz.et", "com.et", "edu.et", "gov.et", "info.et", "name.et", "net.et", "org.et",
  // .fj
  "ac.fj", "biz.fj", "com.fj", "info.fj", "mil.fj", "name.fj", "net.fj", "org.fj", "pro.fj",
  // .fk
  "ac.fk", "co.fk", "gov.fk", "net.fk", "nom.fk", "org.fk",
  // .fr
  "asso.fr", "com.fr", "gouv.fr", "nom.fr", "prd.fr", "presse.fr", "tm.fr",
  // .gg
  "co.gg", "net.gg", "org.gg",
  // .gh
  "com.gh", "edu.gh", "gov.gh", "mil.gh", "org.gh",
  // .gn
  "ac.gn", "com.gn", "gov.gn", "net.gn", "org.gn",
  // .gr
  "com.gr", "edu.gr", "gov.gr", "mil.gr", "net.gr", "org.gr",
  // .gt
  "com.gt", "edu.gt", "gob.gt", "ind.gt", "mil.gt", "net.gt", "org.gt",
  // .gu
  "com.gu", "edu.gu", "gov.gu", "net.gu", "org.gu",
  // .hk
  "com.hk", "edu.hk", "gov.hk", "idv.hk", "net.hk", "org.hk",
  // .id
  "ac.id", "co.id", "go.id", "mil.id", "net.id", "or.id", "sch.id", "web.id",
  // .il
  "ac.il", "co.il", "gov.il", "idf.il", "k12.il", "muni.il", "net.il", "org.il",
  // .in
  "4fd.in", "ac.in", "co.in", "edu.in", "ernet.in", "firm.in", "gen.in", "gov.in",
  "ind.in", "mil.in", "net.in", "nic.in", "org.in", "res.in",
  // .iq
  "com.iq", "edu.iq", "gov.iq", "mil.iq", "net.iq", "org.iq",
  // .ir
  "ac.ir", "co.ir", "dnssec.ir", "gov.ir", "id.ir", "net.ir", "org.ir", "sch.ir",
  // .it
  "edu.it", "gov.it",
  // .je
  "co.je", "net.je", "org.je",
  // .jo
  "com.jo", "edu.jo", "gov.jo", "mil.jo", "name.jo", "net.jo", "org.jo", "sch.jo",
  // .jp
  "ac.jp", "ad.jp", "co.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp", "ne.jp", "or.jp",
  // .ke
  "ac.ke", "co.ke", "go.ke", "info.ke", "me.ke", "mobi.ke", "ne.ke", "or.ke", "sc.ke",
  // .kh
  "com.kh", "edu.kh", "gov.kh", "mil.kh", "net.kh", "org.kh", "per.kh",
  // .ki
  "biz.ki", "com.ki", "de.ki", "edu.ki", "gov.ki", "info.ki", "mob.ki", "net.ki",
  "org.ki", "tel.ki",
  // .km
  "asso.km", "com.km", "coop.km", "edu.km", "gouv.km", "medecin.km", "mil.km",
  "nom.km", "notaires.km", "pharmaciens.km", "presse.km", "tm.km", "veterinaire.km",
  // .kn
  "edu.kn", "gov.kn", "net.kn", "org.kn",
  // .kr
  "ac.kr", "busan.kr", "chungbuk.kr", "chungnam.kr", "co.kr", "daegu.kr",
  "daejeon.kr", "es.kr", "gangwon.kr", "go.kr", "gwangju.kr", "gyeongbuk.kr",
  "gyeonggi.kr", "gyeongnam.kr", "hs.kr", "incheon.kr", "jeju.kr", "jeonbuk.kr",
  "jeonnam.kr", "kg.kr", "mil.kr", "ms.kr", "ne.kr", "or.kr", "pe.kr", "re.kr",
  "sc.kr", "seoul.kr", "ulsan.kr",
  // .kw
  "com.kw", "edu.kw", "gov.kw", "net.kw", "org.kw",
  // .ky
  "com.ky", "edu.ky", "gov.ky", "net.ky", "org.ky",
  // .kz
  "com.kz", "edu.kz", "gov.kz", "mil.kz", "net.kz", "org.kz",
  // .lb
  "com.lb", "edu.lb", "gov.lb", "net.lb", "org.lb",
  // .lk
  "assn.lk", "com.lk", "edu.lk", "gov.lk", "grp.lk", "hotel.lk", "int.lk", "ltd.lk",
  "net.lk", "ngo.lk", "org.lk", "sch.lk", "soc.lk", "web.lk",
  // .lr
  "com.lr", "edu.lr", "gov.lr", "net.lr", "org.lr",
  // .lv
  "asn.lv", "com.lv", "conf.lv", "edu.lv", "gov.lv", "id.lv", "mil.lv", "net.lv", "org.lv",
  // .ly
  "com.ly", "edu.ly", "gov.ly", "id.ly", "med.ly", "net.ly", "org.ly", "plc.ly", "sch.ly",
  // .ma
  "ac.ma", "co.ma", "gov.ma", "net.ma", "org.ma", "press.ma",
  // .mc
  "asso.mc", "tm.mc",
  // .me
  "ac.me", "co.me", "edu.me", "gov.me", "its.me", "net.me", "org.me", "priv.me",
  // .mg
  "com.mg", "edu.mg", "gov.mg", "mil.mg", "nom.mg", "org.mg", "prd.mg", "tm.mg",
  // .mk
  "com.mk", "edu.mk", "gov.mk", "inf.mk", "name.mk", "net.mk", "org.mk", "pro.mk",
  // .ml
  "com.ml", "edu.ml", "gov.ml", "net.ml", "org.ml", "presse.ml",
  // .mn
  "edu.mn", "gov.mn", "org.mn",
  // .mo
  "com.mo", "edu.mo", "gov.mo", "net.mo", "org.mo",
  // .mt
  "com.mt", "edu.mt", "gov.mt", "net.mt", "org.mt",
  // .mu
  "ac.mu", "co.mu", "com.mu", "gov.mu", "net.mu", "or.mu", "org.mu",
  // .mv
  "aero.mv", "biz.mv", "com.mv", "coop.mv", "edu.mv", "gov.mv", "info.mv",
  "int.mv", "mil.mv", "museum.mv", "name.mv", "net.mv", "org.mv", "pro.mv",
  // .mw
  "ac.mw", "co.mw", "com.mw", "coop.mw", "edu.mw", "gov.mw", "int.mw",
  "museum.mw", "net.mw", "org.mw",
  // .mx
  "com.mx", "edu.mx", "gob.mx", "net.mx", "org.mx",
  // .my
  "com.my", "edu.my", "gov.my", "mil.my", "name.my", "net.my", "org.my", "sch.my",
  // .mz
  "ac.mz", "co.mz", "edu.mz", "gov.mz", "org.mz",
  // .na
  "co.na", "com.na",
  // .nf
  "arts.nf", "com.nf", "firm.nf", "info.nf", "net.nf", "other.nf", "per.nf",
  "rec.nf", "store.nf", "web.nf",
  // .ng
  "biz.ng", "com.ng", "edu.ng", "gov.ng", "mil.ng", "mobi.ng", "name.ng",
  "net.ng", "org.ng", "sch.ng",
  // .ni
  "ac.ni", "co.ni", "com.ni", "edu.ni", "gob.ni", "mil.ni", "net.ni", "nom.ni", "org.ni",
  // .np
  "com.np", "edu.np", "gov.np", "mil.np", "net.np", "org.np",
  // .nr
  "biz.nr", "com.nr", "edu.nr", "gov.nr", "info.nr", "net.nr", "org.nr",
  // .nz
  "ac.nz", "co.nz", "cri.nz", "geek.nz", "gen.nz", "govt.nz", "health.nz",
  "iwi.nz", "maori.nz", "mil.nz", "net.nz", "org.nz", "parliament.nz", "school.nz",
  // .om
  "ac.om", "biz.om", "co.om", "com.om", "edu.om", "gov.om", "med.om", "mil.om",
  "museum.om", "net.om", "org.om", "pro.om", "sch.om",
  // .pa
  "abo.pa", "ac.pa", "com.pa", "edu.pa", "gob.pa", "ing.pa", "med.pa", "net.pa",
  "nom.pa", "org.pa", "sld.pa",
  // .pe
  "com.pe", "edu.pe", "gob.pe", "mil.pe", "net.pe", "nom.pe", "org.pe", "sld.pe",
  // .ph
  "com.ph", "edu.ph", "gov.ph", "i.ph", "mil.ph", "net.ph", "ngo.ph", "org.ph",
  // .pk
  "biz.pk", "com.pk", "edu.pk", "fam.pk", "gob.pk", "gok.pk", "gon.pk", "gop.pk",
  "gos.pk", "gov.pk", "net.pk", "org.pk", "web.pk",
  // .pl
  "art.pl", "bialystok.pl", "biz.pl", "com.pl", "edu.pl", "gda.pl", "gdansk.pl",
  "gorzow.pl", "gov.pl", "info.pl", "katowice.pl", "krakow.pl", "lodz.pl",
  "lublin.pl", "mil.pl", "net.pl", "ngo.pl", "olsztyn.pl", "org.pl", "poznan.pl",
  "pwr.pl", "radom.pl", "slupsk.pl", "szczecin.pl", "torun.pl", "warszawa.pl",
  "waw.pl", "wroc.pl", "wroclaw.pl", "zgora.pl",
  // .pr
  "ac.pr", "biz.pr", "com.pr", "edu.pr", "est.pr", "gov.pr", "info.pr", "isla.pr",
  "name.pr", "net.pr", "org.pr", "pro.pr", "prof.pr",
  // .ps
  "com.ps", "edu.ps", "gov.ps", "net.ps", "org.ps", "plo.ps", "sec.ps",
  // .pt
  "com.pt", "edu.pt", "gov.pt", "int.pt", "net.pt", "nome.pt", "org.pt", "publ.pt",
  // .pw
  "belau.pw", "co.pw", "ed.pw", "go.pw", "ne.pw", "or.pw",
  // .py
  "com.py", "edu.py", "gov.py", "mil.py", "net.py", "org.py",
  // .qa
  "com.qa", "edu.qa", "gov.qa", "mil.qa", "net.qa", "org.qa",
  // .re
  "asso.re", "com.re", "nom.re",
  // .ro
  "arts.ro", "com.ro", "firm.ro", "info.ro", "nom.ro", "nt.ro", "org.ro",
  "rec.ro", "store.ro", "tm.ro", "www.ro",
  // .rs
  "ac.rs", "co.rs", "edu.rs", "gov.rs", "in.rs", "org.rs",
  // .ru
  "ac.ru", "adygeya.ru", "altai.ru", "amur.ru", "arkhangelsk.ru", "astrakhan.ru",
  "bashkiria.ru", "belgorod.ru", "bir.ru", "bryansk.ru", "buryatia.ru", "cbg.ru",
  "chel.ru", "chelyabinsk.ru", "chita.ru", "chukotka.ru", "chuvashia.ru", "com.ru",
  "dagestan.ru", "e-burg.ru", "edu.ru", "gov.ru", "grozny.ru", "int.ru",
  "irkutsk.ru", "ivanovo.ru", "izhevsk.ru", "jar.ru", "joshkar-ola.ru",
  "kalmykia.ru", "kaluga.ru", "kamchatka.ru", "karelia.ru", "kazan.ru", "kchr.ru",
  "kemerovo.ru", "khabarovsk.ru", "khakassia.ru", "khv.ru", "kirov.ru",
  "koenig.ru", "komi.ru", "kostroma.ru", "kranoyarsk.ru", "kuban.ru", "kurgan.ru",
  "kursk.ru", "lipetsk.ru", "magadan.ru", "mari.ru", "mari-el.ru", "marine.ru",
  "mil.ru", "mordovia.ru", "mosreg.ru", "msk.ru", "murmansk.ru", "nalchik.ru",
  "net.ru", "nnov.ru", "nov.ru", "novosibirsk.ru", "nsk.ru", "omsk.ru",
  "orenburg.ru", "org.ru", "oryol.ru", "penza.ru", "perm.ru", "pp.ru", "pskov.ru",
  "ptz.ru", "rnd.ru", "ryazan.ru", "sakhalin.ru", "samara.ru", "saratov.ru",
  "simbirsk.ru", "smolensk.ru", "spb.ru", "stavropol.ru", "stv.ru", "surgut.ru",
  "tambov.ru", "tatarstan.ru", "tom.ru", "tomsk.ru", "tsaritsyn.ru", "tsk.ru",
  "tula.ru", "tuva.ru", "tver.ru", "tyumen.ru", "udm.ru", "udmurtia.ru",
  "ulan-ude.ru", "vladikavkaz.ru", "vladimir.ru", "vladivostok.ru", "volgograd.ru",
  "vologda.ru", "voronezh.ru", "vrn.ru", "vyatka.ru", "yakutia.ru", "yamal.ru",
  "yekaterinburg.ru", "yuzhno-sakhalinsk.ru",
  // .rw
  "ac.rw", "co.rw", "com.rw", "edu.rw", "gouv.rw", "gov.rw", "int.rw", "mil.rw", "net.rw",
  // .sa
  "com.sa", "edu.sa", "gov.sa", "med.sa", "net.sa", "org.sa", "pub.sa", "sch.sa",
  // .sb
  "com.sb", "edu.sb", "gov.sb", "net.sb", "org.sb",
  // .sc
  "com.sc", "edu.sc", "gov.sc", "net.sc", "org.sc",
  // .sd
  "com.sd", "edu.sd", "gov.sd", "info.sd", "med.sd", "net.sd", "org.sd", "tv.sd",
  // .se
  "a.se", "ac.se", "b.se", "bd.se", "c.se", "d.se", "e.se", "f.se", "g.se",
  "h.se", "i.se", "k.se", "l.se", "m.se", "n.se", "o.se", "org.se", "p.se",
  "parti.se", "pp.se", "press.se", "r.se", "s.se", "t.se", "tm.se", "u.se",
  "w.se", "x.se", "y.se", "z.se",
  // .sg
  "com.sg", "edu.sg", "gov.sg", "idn.sg", "net.sg", "org.sg", "per.sg",
  // .sh
  "co.sh", "com.sh", "edu.sh", "gov.sh", "net.sh", "nom.sh", "org.sh",
  // .sl
  "com.sl", "edu.sl", "gov.sl", "net.sl", "org.sl",
  // .sn
  "art.sn", "com.sn", "edu.sn", "gouv.sn", "org.sn", "perso.sn", "univ.sn",
  // .st
  "co.st", "com.st", "consulado.st", "edu.st", "embaixada.st", "gov.st", "mil.st",
  "net.st", "org.st", "principe.st", "saotome.st", "store.st",
  // .sv
  "com.sv", "edu.sv", "gob.sv", "org.sv", "red.sv",
  // .sy
  "com.sy", "edu.sy", "gov.sy", "mil.sy", "net.sy", "news.sy", "org.sy",
  // .sz
  "ac.sz", "co.sz", "org.sz",
  // .th
  "ac.th", "co.th", "go.th", "in.th", "mi.th", "net.th", "or.th",
  // .tj
  "ac.tj", "biz.tj", "co.tj", "com.tj", "edu.tj", "go.tj", "gov.tj", "info.tj",
  "int.tj", "mil.tj", "name.tj", "net.tj", "nic.tj", "org.tj", "test.tj", "web.tj",
  // .tn
  "agrinet.tn", "com.tn", "defense.tn", "edunet.tn", "ens.tn", "fin.tn", "gov.tn",
  "ind.tn", "info.tn", "intl.tn", "mincom.tn", "nat.tn", "net.tn", "org.tn",
  "perso.tn", "rnrt.tn", "rns.tn", "rnu.tn", "tourism.tn",
  // .tr
  "av.tr", "bbs.tr", "bel.tr", "biz.tr", "com.tr", "dr.tr", "edu.tr", "gen.tr",
  "gov.tr", "info.tr", "k12.tr", "name.tr", "net.tr", "org.tr", "pol.tr",
  "tel.tr", "tsk.tr", "tv.tr", "web.tr",
  // .tt
  "aero.tt", "biz.tt", "cat.tt", "co.tt", "com.tt", "coop.tt", "edu.tt", "gov.tt",
  "info.tt", "int.tt", "jobs.tt", "mil.tt", "mobi.tt", "museum.tt", "name.tt",
  "net.tt", "org.tt", "pro.tt", "tel.tt", "travel.tt",
  // .tw
  "club.tw", "com.tw", "ebiz.tw", "edu.tw", "game.tw", "gov.tw", "idv.tw",
  "mil.tw", "net.tw", "org.tw",
  // .tz
  "ac.tz", "co.tz", "go.tz", "ne.tz", "or.tz",
  // .ua
  "biz.ua", "cherkassy.ua", "chernigov.ua", "chernovtsy.ua", "ck.ua", "cn.ua",
  "co.ua", "com.ua", "crimea.ua", "cv.ua", "dn.ua", "dnepropetrovsk.ua",
  "donetsk.ua", "dp.ua", "edu.ua", "gov.ua", "if.ua", "in.ua",
  "ivano-frankivsk.ua", "kh.ua", "kharkov.ua", "kherson.ua", "khmelnitskiy.ua",
  "kiev.ua", "kirovograd.ua", "km.ua", "kr.ua", "ks.ua", "kv.ua", "lg.ua",
  "lugansk.ua", "lutsk.ua", "lviv.ua", "me.ua", "mk.ua", "net.ua",
  "nikolaev.ua", "od.ua", "odessa.ua", "org.ua", "pl.ua", "poltava.ua", "pp.ua",
  "rovno.ua", "rv.ua", "sebastopol.ua", "sumy.ua", "te.ua", "ternopil.ua",
  "uzhgorod.ua", "vinnica.ua", "vn.ua", "zaporizhzhe.ua", "zhitomir.ua",
  "zp.ua", "zt.ua",
  // .ug
  "ac.ug", "co.ug", "go.ug", "ne.ug", "or.ug", "org.ug", "sc.ug",
  // .uk
  "ac.uk", "bl.uk", "british-library.uk", "co.uk", "cym.uk", "gov.uk", "govt.uk",
  "icnet.uk", "jet.uk", "lea.uk", "ltd.uk", "me.uk", "mil.uk", "mod.uk",
  "national-library-scotland.uk", "nel.uk", "net.uk", "nhs.uk", "nic.uk",
  "nls.uk", "org.uk", "orgn.uk", "parliament.uk", "plc.uk", "police.uk",
  "sch.uk", "scot.uk", "soc.uk",
  // .us
  "4fd.us", "dni.us", "fed.us", "isa.us", "kids.us", "nsn.us",
  // .uy
  "com.uy", "edu.uy", "gub.uy", "mil.uy", "net.uy", "org.uy",
  // .ve
  "co.ve", "com.ve", "edu.ve", "gob.ve", "info.ve", "mil.ve", "net.ve", "org.ve", "web.ve",
  // .vi
  "co.vi", "com.vi", "k12.vi", "net.vi", "org.vi",
  // .vn
  "ac.vn", "biz.vn", "com.vn", "edu.vn", "gov.vn", "health.vn", "info.vn",
  "int.vn", "name.vn", "net.vn", "org.vn", "pro.vn",
  // .ye
  "co.ye", "com.ye", "gov.ye", "ltd.ye", "me.ye", "net.ye", "org.ye", "plc.ye",
  // .yu
  "ac.yu", "co.yu", "edu.yu", "gov.yu", "org.yu",
  // .za
  "ac.za", "agric.za", "alt.za", "bourse.za", "city.za", "co.za", "cybernet.za",
  "db.za", "edu.za", "gov.za", "grondar.za", "iaccess.za", "imt.za", "inca.za",
  "landesign.za", "law.za", "mil.za", "net.za", "ngo.za", "nis.za", "nom.za",
  "olivetti.za", "org.za", "pix.za", "school.za", "tm.za", "web.za",
  // .zm
  "ac.zm", "co.zm", "com.zm", "edu.zm", "gov.zm", "net.zm", "org.zm", "sch.zm",
]);

function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.length >= 3 ? parts.slice(-3).join(".") : domain;
  }
  return parts.slice(-2).join(".");
}

function evictOldest() {
  if (cache.size < CACHE_MAX_SIZE) return;
  // Evict the oldest entry
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get('domain');

  if (!domain || !isValidDomain(domain)) {
    return new NextResponse(null, {
      status: 400,
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
  }

  // Resolve to root domain so subdomains share the same favicon lookup
  const normalizedDomain = getRootDomain(domain.toLowerCase());

  // Check negative cache (domains known to have no favicon)
  const neg = negativeCache.get(normalizedDomain);
  if (neg && Date.now() - neg.fetchedAt < NEGATIVE_CACHE_TTL_MS) {
    return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
  }

  // Check cache
  const cached = cache.get(normalizedDomain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return new NextResponse(cached.data, {
      headers: faviconHeaders(cached.contentType),
    });
  }

  try {
    const upstream = await fetch(
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!upstream.ok) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }

    // Served inline on the webmail origin, so only raster image types pass:
    // an image/svg+xml or text/html favicon opened on its own would run
    // script as the webmail.
    const contentType = rasterFaviconType(upstream.headers.get('content-type'));
    if (!contentType) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }
    const data = await upstream.arrayBuffer();

    // Don't cache empty/tiny responses (likely no real favicon)
    if (data.byteLength < 10) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }

    // Cache the result
    evictOldest();
    cache.set(normalizedDomain, { data, contentType, fetchedAt: Date.now() });

    return new NextResponse(data, {
      headers: faviconHeaders(contentType),
    });
  } catch {
    return new NextResponse(null, {
      status: 502,
      headers: { 'Cache-Control': 'public, max-age=300' }, // 5 min
    });
  }
}

const RASTER_FAVICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/bmp',
]);

/** The upstream type when it is a raster image, else null. */
function rasterFaviconType(header: string | null): string | null {
  const type = (header ?? 'image/x-icon').split(';')[0].trim().toLowerCase();
  return RASTER_FAVICON_TYPES.has(type) ? type : null;
}

function faviconHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=1209600', // 2 weeks
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

function evictNegativeOldest() {
  if (negativeCache.size < NEGATIVE_CACHE_MAX_SIZE) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of negativeCache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) negativeCache.delete(oldestKey);
}
