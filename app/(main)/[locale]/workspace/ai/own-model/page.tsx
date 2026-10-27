"use client";

// Step 44: guide for admins — run a model on own hardware (Ollama, e.g. on a
// Mac Studio) and connect it through a Cloudflare Tunnel, no open ports.
// Step 45: everything as system services, so it survives a restart.
import { Link } from "@/i18n/navigation";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

const HOST = "llm.ihre-firma.de";

const OLLAMA = `brew install ollama
ollama pull qwen3.6:35b-a3b`;

// Step 45: Ollama as a system service (starts at boot, without anyone signed in),
// with the settings for xenaxio; the GPU memory is set again at every boot.
const OLLAMA_SERVICE = `OLLAMA_BIN="$(command -v ollama)"
sudo tee /Library/LaunchDaemons/de.xenaxio.ollama.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.xenaxio.ollama</string>
  <key>UserName</key><string>$USER</string>
  <key>ProgramArguments</key><array><string>$OLLAMA_BIN</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>OLLAMA_CONTEXT_LENGTH</key><string>32768</string>
    <key>OLLAMA_KEEP_ALIVE</key><string>-1</string>
    <key>OLLAMA_NUM_PARALLEL</key><string>2</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
sudo launchctl bootstrap system /Library/LaunchDaemons/de.xenaxio.ollama.plist`;

const MAC = `sudo tee /Library/LaunchDaemons/de.xenaxio.gpu-memory.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.xenaxio.gpu-memory</string>
  <key>ProgramArguments</key><array><string>/usr/sbin/sysctl</string><string>iogpu.wired_limit_mb=56000</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
sudo launchctl bootstrap system /Library/LaunchDaemons/de.xenaxio.gpu-memory.plist
sudo pmset -a sleep 0 disksleep 0 autorestart 1`;

const OLLAMA_CHECK = `ollama run qwen3.6:35b-a3b "Hallo"
ollama ps`;

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
        <Snippet value={OLLAMA_SERVICE} />
        {p("s2_mac")}
        <Snippet value={MAC} />
        {p("s2_check")}
        <Snippet value={OLLAMA_CHECK} />
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
