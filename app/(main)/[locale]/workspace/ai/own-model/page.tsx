"use client";

// Step 44: guide for admins — run a model on own hardware (Ollama, e.g. on a
// Mac Studio) and connect it through a Cloudflare Tunnel, no open ports.
import { Link } from "@/i18n/navigation";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

const HOST = "llm.ihre-firma.de";

const OLLAMA = `brew install ollama
ollama pull qwen3.6:35b-a3b`;

const OLLAMA_ENV = `launchctl setenv OLLAMA_CONTEXT_LENGTH 32768
launchctl setenv OLLAMA_KEEP_ALIVE -1
launchctl setenv OLLAMA_NUM_PARALLEL 2`;

const MAC = `sudo sysctl iogpu.wired_limit_mb=56000
sudo pmset -a sleep 0 disksleep 0 autorestart 1`;

const TUNNEL = `brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create xenaxio-llm
cloudflared tunnel route dns xenaxio-llm ${HOST}`;

const TUNNEL_CONFIG = `tunnel: xenaxio-llm
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: ${HOST}
    service: http://localhost:11434
    originRequest:
      httpHostHeader: localhost:11434
  - service: http_status:404`;

const TUNNEL_SERVICE = `sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo nano /etc/cloudflared/config.yml
sudo cloudflared service install`;

const CHECK = `curl https://${HOST}/v1/models \\
  -H "CF-Access-Client-Id: <Client ID>" \\
  -H "CF-Access-Client-Secret: <Client Secret>"`;

function Snippet({ value }: { value: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto whitespace-pre rounded-md border border-border bg-muted px-3 py-2 text-xs">{value}</pre>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

function Guide() {
  const t = useXT();
  const p = (key: string) => <p className="text-sm text-muted-foreground">{t(`ownmodel.${key}`)}</p>;
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm">{t("ownmodel.intro")}</p>
      <Step n={1} title={t("ownmodel.s1_title")}>
        {p("s1_text")}
        <Snippet value={OLLAMA} />
        {p("s1_models")}
      </Step>
      <Step n={2} title={t("ownmodel.s2_title")}>
        {p("s2_text")}
        <Snippet value={OLLAMA_ENV} />
        {p("s2_mac")}
        <Snippet value={MAC} />
        {p("s2_note")}
      </Step>
      <Step n={3} title={t("ownmodel.s3_title")}>
        {p("s3_text")}
        <Snippet value={TUNNEL} />
        {p("s3_config")}
        <Snippet value={TUNNEL_CONFIG} />
        {p("s3_host")}
        <Snippet value={TUNNEL_SERVICE} />
      </Step>
      <Step n={4} title={t("ownmodel.s4_title")}>
        {p("s4_text")}
        {p("s4_check")}
        <Snippet value={CHECK} />
      </Step>
      <Step n={5} title={t("ownmodel.s5_title")}>
        {p("s5_text")}
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("ownmodel.s5_url", { url: `https://${HOST}/v1` })}</li>
          <li>{t("ownmodel.s5_model")}</li>
          <li>{t("ownmodel.s5_headers")}</li>
        </ul>
        {p("s5_switch")}
        <Link href="/workspace/ai" className="text-sm text-primary underline underline-offset-4">
          {t("ownmodel.back")}
        </Link>
      </Step>
      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("ownmodel.other_title")}</h2>
        {p("other_text")}
      </section>
      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("ownmodel.privacy_title")}</h2>
        {p("privacy_text")}
      </section>
    </div>
  );
}

export default function OwnModelGuidePage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("ownmodel.title")} backHref="/workspace/ai" requireAdmin>
      <Guide />
    </WorkspaceShell>
  );
}
