import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BookOpen, Heart, Mail, CalendarDays, UserRound, ChevronRight, Check, Copy, Send, Sparkles, Leaf, LockKeyhole, ArrowLeft, MessageCircle, PenLine, RefreshCw, Sun, NotebookPen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { devotionalsA } from "@/content/devotionals-a";
import { devotionalsB } from "@/content/devotionals-b";
import { devotionalsC } from "@/content/devotionals-c";
import type { Devotional } from "@/content/types";
import type { User } from "@supabase/supabase-js";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Devocional" }, { name: "description", content: "Um momento de fé, reflexão e palavras que aproximam." }] }),
  component: DevocionalApp,
});

type Page = "hoje" | "leitura" | "diario" | "mensagens" | "jornada" | "perfil";
type Progress = { read_done: boolean; reflect_done: boolean; pray_done: boolean; commitment_done: boolean; completed_at: string | null };
type Note = { id: string; author_id: string; day: string; summary: string; message: string; status: string; shared_at: string | null; edited_at: string | null };
type Reply = { id: string; note_id: string; author_id: string; body: string; created_at: string };
const catalog: Devotional[] = [...devotionalsA, ...devotionalsB, ...devotionalsC].sort((a, b) => a.id - b.id);
const emptyProgress: Progress = { read_done: false, reflect_done: false, pray_done: false, commitment_done: false, completed_at: null };
const db = supabase;

function brasilDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const read = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
  return read("year") + "-" + read("month") + "-" + read("day");
}
function dateIndex(day: string) {
  const base = Date.parse("2026-11-07T00:00:00Z");
  const offset = Math.floor((Date.parse(day + "T00:00:00Z") - base) / 86400000);
  return ((offset % catalog.length) + catalog.length) % catalog.length;
}
function devotionFor(day: string) { return catalog[dateIndex(day)] ?? catalog[0]; }
function prettyDate(day: string) { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z")); }
function prettyShort(day: string) { return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z")); }
function notifyError(error: unknown) { return error instanceof Error ? error.message : String(error); }

function localRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem("devocional:" + key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
}
function localWrite(key: string, value: unknown) {
  try { window.localStorage.setItem("devocional:" + key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function DevocionalApp() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<Page>("hoje");
  const [day, setDay] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [invite, setInvite] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [partner, setPartner] = useState<{ id: string; name: string } | null>(null);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [history, setHistory] = useState<Array<{ day: string; completed_at: string | null; read_done: boolean }>>([]);
  const [reflection, setReflection] = useState("");
  const [summary, setSummary] = useState("");
  const [message, setMessage] = useState("");
  const [myNote, setMyNote] = useState<Note | null>(null);
  const [otherNote, setOtherNote] = useState<Note | null>(null);
  const [inbox, setInbox] = useState<Note[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [readingStep, setReadingStep] = useState(0);
  const devotional = useMemo(() => devotionFor(day || "2026-11-07"), [day]);
  const isToday = day === brasilDay();
  const completed = [progress.read_done, progress.reflect_done, progress.pray_done, progress.commitment_done].filter(Boolean).length;

  useEffect(() => {
    setDay(brasilDay());
    let mounted = true;
    const enterDirectly = async () => {
      try {
        const { data: sessionResult, error: sessionError } = await db.auth.getSession();
        if (sessionError) throw sessionError;
        let nextUser = sessionResult.session?.user ?? null;
        if (!nextUser) {
          const { data: anonResult, error: anonError } = await db.auth.signInAnonymously();
          if (anonError || !anonResult.user) throw anonError ?? new Error("Não foi possível iniciar a sessão anônima.");
          nextUser = anonResult.user;
        }
        if (mounted) { setUser(nextUser); setLocalOnly(false); }
      } catch {
        // If anonymous auth is not enabled or connectivity is unavailable,
        // reading and private local journaling must still work without login.
        if (mounted) {
          setUser({ id: "local-guest", user_metadata: { display_name: "Você" } } as User);
          setLocalOnly(true);
        }
      } finally {
        if (mounted) setBooting(false);
      }
    };
    void enterDirectly();
    const { data: listener } = db.auth.onAuthStateChange((_event, session) => {
      if (mounted && session?.user) { setUser(session.user); setLocalOnly(false); setBooting(false); }
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!user || !day) return;
    let cancelled = false;
    const load = async () => {
      setSaving(true);
      if (localOnly) {
        const storedProgress = localRead<Progress>("progress:" + day, emptyProgress);
        setProgress(storedProgress);
        setProfileName(localRead<string>("name", "Você"));
        setReflection(localRead<string>("journal:" + day, ""));
        const draft = localRead<Pick<Note, "summary" | "message">>("note:" + day, { summary: "", message: "" });
        setSummary(draft.summary); setMessage(draft.message); setMyNote(null);
        const days = Object.keys(localStorage).filter((key) => key.startsWith("devocional:progress:")).map((key) => key.replace("devocional:progress:", ""));
        setHistory(days.map((d) => ({ day: d, completed_at: localRead<Progress>("progress:" + d, emptyProgress).completed_at, read_done: localRead<Progress>("progress:" + d, emptyProgress).read_done })).sort((a,b) => b.day.localeCompare(a.day)));
        setPartner(null); setSpaceId(null); setInvite(""); setInbox([]); setReplies([]); setOtherNote(null); setSaving(false);
        return;
      }
      const [{ data: profile }, { data: member }, { data: myProgress }, { data: journal }, { data: ownNote }, { data: oldProgress }] = await Promise.all([
        db.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
        db.from("space_members").select("space_id").eq("user_id", user.id).maybeSingle(),
        db.from("daily_progress").select("*").eq("user_id", user.id).eq("day", day).maybeSingle(),
        db.from("journal_entries").select("reflection").eq("user_id", user.id).eq("day", day).maybeSingle(),
        db.from("shared_notes").select("*").eq("author_id", user.id).eq("day", day).maybeSingle(),
        db.from("daily_progress").select("day,completed_at,read_done").eq("user_id", user.id).order("day", { ascending: false }).limit(120),
      ]);
      if (cancelled) return;
      setProfileName(profile?.display_name ?? user.user_metadata?.display_name ?? "");
      const sid = member?.space_id ?? null;
      setSpaceId(sid);
      setProgress(myProgress ? { read_done: myProgress.read_done, reflect_done: myProgress.reflect_done, pray_done: myProgress.pray_done, commitment_done: myProgress.commitment_done, completed_at: myProgress.completed_at } : emptyProgress);
      setHistory(oldProgress ?? []);
      setReflection(journal?.reflection ?? "");
      setSummary(ownNote?.summary ?? "");
      setMessage(ownNote?.message ?? "");
      setMyNote(ownNote ?? null);
      if (sid) {
        const [{ data: place }, { data: members }, { data: notes }] = await Promise.all([
          db.from("spaces").select("invite_code").eq("id", sid).maybeSingle(),
          db.from("space_members").select("user_id").eq("space_id", sid),
          db.from("shared_notes").select("*").eq("space_id", sid).eq("status", "shared").order("day", { ascending: false }),
        ]);
        if (cancelled) return;
        setInvite(place?.invite_code ?? "");
        const theirId = members?.find((m) => m.user_id !== user.id)?.user_id;
        if (theirId) {
          const { data: theirProfile } = await db.from("profiles").select("display_name").eq("id", theirId).maybeSingle();
          if (!cancelled) setPartner({ id: theirId, name: theirProfile?.display_name || "Seu convite" });
        } else { setPartner(null); }
        if (cancelled) return;
        setInbox(notes ?? []);
        setOtherNote(notes?.find((n) => n.day === day && n.author_id !== user.id) ?? null);
        if (notes?.length) {
          const { data: responseData } = await db.from("note_replies").select("*").in("note_id", notes.map((n) => n.id)).order("created_at");
          if (!cancelled) setReplies(responseData ?? []);
        } else setReplies([]);
      } else { setInvite(""); setPartner(null); setOtherNote(null); setInbox([]); setReplies([]); }
      if (!cancelled) setSaving(false);
    };
    void load().catch((e) => { if (!cancelled) { setSaving(false); setNotice(notifyError(e)); } });
    return () => { cancelled = true; };
  }, [user?.id, day, localOnly]);

  async function refresh() {
    if (!user) return;
    setDay("");
    window.setTimeout(() => setDay(brasilDay()), 10);
  }
  async function updateProgress(field: keyof Omit<Progress, "completed_at">) {
    if (!user) return;
    const next = { ...progress, [field]: !progress[field] };
    const done = next.read_done && next.reflect_done && next.pray_done;
    const completed_at = done ? (progress.completed_at ?? new Date().toISOString()) : null;
    setProgress({ ...next, completed_at });
    if (localOnly) {
      if (!localWrite("progress:" + day, { ...next, completed_at })) { setNotice("Não foi possível salvar neste dispositivo."); return; }
      setHistory((previous) => [{ day, completed_at, read_done: next.read_done }, ...previous.filter((h) => h.day !== day)].sort((a, b) => b.day.localeCompare(a.day)));
      if (done && !progress.completed_at) setNotice("Que bonito! O devocional de hoje foi concluído. ✨");
      return;
    }
    const { error } = await db.from("daily_progress").upsert({ user_id: user.id, day, devotional_id: devotional.id, ...next, completed_at }, { onConflict: "user_id,day" });
    if (error) { setProgress(progress); setNotice(error.message); }
    else if (done && !progress.completed_at) setNotice("Que bonito! O devocional de hoje foi concluído. ✨");
  }
  async function saveJournal() {
    if (!user) return;
    if (localOnly) { setNotice(localWrite("journal:" + day, reflection) ? "Sua reflexão foi salva neste dispositivo." : "Não foi possível salvar neste dispositivo."); return; }
    setBusy(true);
    const { error } = await db.from("journal_entries").upsert({ user_id: user.id, day, reflection }, { onConflict: "user_id,day" });
    setBusy(false); setNotice(error ? error.message : "Sua reflexão pessoal foi salva.");
  }
  async function saveNote(publish: boolean) {
    if (!user) return;
    if (publish && !partner) { setNotice("Conecte a outra pessoa para compartilhar."); return; }
    if (publish && !summary.trim() && !message.trim()) { setNotice("Escreva uma mensagem ou resumo primeiro."); return; }
    if (publish && !window.confirm("Compartilhar agora sua mensagem e seu resumo? A outra pessoa poderá ler depois de compartilhar o próprio registro.")) return;
    setBusy(true);
    const status = publish || myNote?.status === "shared" ? "shared" : "draft";
    if (localOnly) { setBusy(false); setNotice(localWrite("note:" + day, { summary, message }) ? "Rascunho salvo neste dispositivo." : "Não foi possível salvar neste dispositivo."); return; }
    const { data, error } = await db.from("shared_notes").upsert({ author_id: user.id, day, summary, message, status }, { onConflict: "author_id,day" }).select("*").single();
    setBusy(false);
    if (error) { setNotice(error.message); return; }
    setMyNote(data);
    setNotice(status === "shared" ? "Seu registro foi compartilhado com carinho. 💌" : "Rascunho salvo só para você.");
    if (status === "shared") await loadShared();
  }
  async function loadShared() {
    if (!user || !spaceId || localOnly) return;
    const { data } = await db.from("shared_notes").select("*").eq("space_id", spaceId).eq("status", "shared").order("day", { ascending: false });
    setInbox(data ?? []);
    setOtherNote(data?.find((n) => n.day === day && n.author_id !== user.id) ?? null);
    if (data?.length) {
      const { data: r } = await db.from("note_replies").select("*").in("note_id", data.map((n) => n.id)).order("created_at");
      setReplies(r ?? []);
    }
  }
  async function sendReply(noteId: string) {
    if (!user || !replyText[noteId]?.trim()) return;
    setBusy(true);
    const { error } = await db.from("note_replies").insert({ author_id: user.id, note_id: noteId, body: replyText[noteId].trim() });
    setBusy(false);
    if (error) { setNotice(error.message); return; }
    setReplyText((old) => ({ ...old, [noteId]: "" }));
    setNotice("Sua resposta foi enviada.");
    await loadShared();
  }
  async function createInvite() {
    if (localOnly) { setNotice("O compartilhamento precisa de uma conexão segura. Tente ativá-lo neste dispositivo."); return; }
    setBusy(true); const { data, error } = await db.rpc("create_space");
    setBusy(false); if (error) setNotice(error.message); else { setInvite(String(data)); setNotice("Convite criado. Compartilhe o código com alguém especial."); await refresh(); }
  }
  async function joinInvite() {
    if (localOnly) { setNotice("O compartilhamento precisa de uma conexão segura. Tente ativá-lo neste dispositivo."); return; }
    setBusy(true); const { error } = await db.rpc("join_space", { _code: inviteInput.trim().toUpperCase() });
    setBusy(false); if (error) setNotice(error.message); else { setNotice("Vocês estão conectados!"); await refresh(); }
  }
  async function updateName() {
    if (!user || !profileName.trim()) return;
    if (localOnly) { setNotice(localWrite("name", profileName.trim()) ? "Seu nome foi salvo neste dispositivo." : "Não foi possível salvar neste dispositivo."); return; }
    setBusy(true); const { error } = await db.from("profiles").update({ display_name: profileName.trim() }).eq("id", user.id);
    setBusy(false); setNotice(error ? error.message : "Nome atualizado.");
  }
  async function retrySecureAccess() {
    setBusy(true);
    const { data, error } = await db.auth.signInAnonymously();
    setBusy(false);
    if (error || !data.user) { setNotice("O compartilhamento entre dispositivos ainda não está disponível. Suas leituras continuam acessíveis aqui."); return; }
    setUser(data.user); setLocalOnly(false); setNotice("Seu espaço seguro foi ativado. Você já pode criar ou aceitar um convite.");
  }
  function copy(text: string) {
    if (!navigator.clipboard) { setNotice("Seu navegador não permite copiar automaticamente."); return; }
    void navigator.clipboard.writeText(text).then(() => setNotice("Copiado!")).catch(() => setNotice("Não foi possível copiar."));
  }
  function go(newPage: Page) { setPage(newPage); setNotice(""); window.scrollTo?.({ top: 0, behavior: "smooth" }); }
  const firstName = profileName.trim().split(" ")[0] || "você";

  if (booting || !day) return <div className="dv-loading"><Leaf size={28} className="dv-spin" /><p>Preparando um momento especial...</p></div>;

  const navigation: Array<{ key: Page; label: string; icon: typeof Heart }> = [
    { key: "hoje", label: "Hoje", icon: Sun }, { key: "leitura", label: "Devocional", icon: BookOpen }, { key: "diario", label: "Meu diário", icon: NotebookPen }, { key: "mensagens", label: "Mensagens", icon: Mail }, { key: "jornada", label: "Nossa jornada", icon: CalendarDays }, { key: "perfil", label: "Perfil", icon: UserRound },
  ];
  return <div className="dv-app">
    <aside className="dv-sidebar"><button className="dv-brand dv-brand-button" onClick={() => go("hoje")}><Leaf size={25} /> Devocional</button><p className="dv-sidebar-eyebrow">UM DIA DE CADA VEZ</p>
      <nav aria-label="Navegação principal">{navigation.map(({ key, label, icon: Icon }) => <button key={key} className={"dv-nav " + (page === key ? "active" : "")} onClick={() => go(key)}><Icon size={19} />{label}{page === key && <span className="dv-nav-dot" />}</button>)}</nav>
      <div className="dv-side-note"><Sparkles size={18} /><p>Que a graça encontre espaço nos pequenos momentos de hoje.</p><small>Com carinho, Devocional</small></div>

    </aside>
    <div className="dv-main">
      <header className="dv-topbar"><div className="dv-toplogo"><Leaf size={18} /> Devocional</div><span><Sun size={15} /> {prettyDate(brasilDay())}</span><button className="dv-user" onClick={() => go("perfil")}><UserRound size={17} /> {firstName}</button></header>
      {localOnly && <div className="dv-flash" role="status"><LockKeyhole size={16} /> Acesso direto: seus registros ficam neste dispositivo. O compartilhamento depende de ativar a conexão segura.</div>}
      {notice && <div className="dv-flash" role="status"><Sparkles size={16} /> {notice} <button aria-label="Fechar aviso" onClick={() => setNotice("")}>×</button></div>}
      <main className="dv-content">
        {page === "hoje" && <><div className="dv-greeting"><span className="dv-kicker">SEU MOMENTO COM DEUS · {prettyDate(day).toUpperCase()}</span><h1>Um bom dia começa <em>por dentro.</em></h1><p>Olá, {firstName}. Existe uma palavra reservada para este dia.</p></div>
          <div className="dv-hero"><div className="dv-hero-copy"><div className="dv-pill"><BookOpen size={14} /> DEVOCIONAL DO DIA <span>· Dia {dateIndex(day) + 1}</span></div><h2>{devotional.title}</h2><p className="dv-hero-verse">“{devotional.verse}”</p><p className="dv-ref">Inspirado em {devotional.reference}</p><button className="dv-primary" onClick={() => { setReadingStep(0); go("leitura"); }}>Começar meu devocional <ChevronRight size={18} /></button></div><div className="dv-hero-drawing"><div className="dv-arch"><Leaf size={88} strokeWidth={0.75} /><span>floresça no<br />tempo certo</span></div></div></div>
          <div className="dv-sectionheading"><div><span className="dv-kicker">PEQUENOS PASSOS, GRANDES ENCONTROS</span><h3>Seu caminho de hoje</h3></div><strong>{completed}/4 concluídos</strong></div><div className="dv-progressrail"><div style={{ width: completed * 25 + "%" }} /></div>
          <div className="dv-steps">{[["Leitura", "Acolher a Palavra", BookOpen, progress.read_done], ["Reflexão", "Olhar para dentro", PenLine, progress.reflect_done], ["Oração", "Conversar com Deus", Heart, progress.pray_done], ["Nosso espaço", "Guardar e compartilhar", Mail, progress.commitment_done]].map(([title, sub, Icon, done], i) => { const ItemIcon = Icon as typeof BookOpen; return <button key={String(title)} className="dv-step-card" onClick={() => { setReadingStep(Math.min(i, 3)); go("leitura"); }}><span className={"dv-step-icon " + (done ? "done" : "")}>{done ? <Check size={21} /> : <ItemIcon size={21} />}</span><span><strong>{String(title)}</strong><small>{String(sub)}</small></span><ChevronRight size={18} /></button>; })}</div>
          <div className="dv-twocol"><section className="dv-softcard"><span className="dv-kicker">GESTO DO DIA</span><h3>Um pequeno compromisso</h3><p>{devotional.practice}</p><button className="dv-textbutton" onClick={() => void updateProgress("commitment_done")}>{progress.commitment_done ? <><Check size={17} /> Compromisso vivido</> : <>Marcar como realizado <ChevronRight size={16} /></>}</button></section><section className="dv-softcard dv-sage"><span className="dv-kicker">PALAVRAS QUE APROXIMAM</span><h3>Nosso espaço</h3><p>{partner ? "Um lugar para registrar o que tocou seu coração e compartilhar com " + partner.name + "." : "Convide alguém especial e criem uma jornada de palavras, fé e presença."}</p><button className="dv-textbutton" onClick={() => go(partner ? "mensagens" : "perfil")}>{partner ? "Ver nossas mensagens" : "Convidar alguém"} <ChevronRight size={16} /></button></section></div>
        </>}
        {page === "leitura" && <><button className="dv-back" onClick={() => go("hoje")}><ArrowLeft size={16} /> Voltar para o início</button><div className="dv-readinghead"><span className="dv-kicker">DEVOCIONAL · DIA {dateIndex(day) + 1} · {prettyShort(day).toUpperCase()}</span><h1>{devotional.title}</h1><p>Um tempo para desacelerar e ouvir o que Deus deseja ensinar.</p></div><div className="dv-journeybar">{["Ler", "Refletir", "Orar", "Compartilhar"].map((s, i) => <button key={s} className={readingStep === i ? "selected" : ""} onClick={() => setReadingStep(i)}><span>{i + 1}</span>{s}</button>)}</div>
          {readingStep === 0 && <article className="dv-readingcard"><div className="dv-readingicon"><BookOpen size={23} /></div><span className="dv-kicker">A PALAVRA DE HOJE</span><blockquote>“{devotional.verse}”</blockquote><p className="dv-ref">Paráfrase inspirada em {devotional.reference}</p><div className="dv-readingtext">{devotional.reading.map((p, i) => <p key={i}>{p}</p>)}</div><div className="dv-readingfooter"><button className="dv-subtle" onClick={() => copy(devotional.reference + " — " + devotional.verse)}><Copy size={16} /> Copiar referência</button><button className="dv-primary" onClick={() => { if (!progress.read_done) void updateProgress("read_done"); setReadingStep(1); }}>Concluir leitura <ChevronRight size={17} /></button></div></article>}
          {readingStep === 1 && <section className="dv-readingcard"><div className="dv-readingicon"><PenLine size={23} /></div><span className="dv-kicker">UM OLHAR PARA DENTRO</span><h2>O que floresceu em você?</h2><div className="dv-question"><small>PARA O SEU CORAÇÃO</small><p>{devotional.heartQuestion}</p></div><div className="dv-question"><small>PARA CONVERSAREM</small><p>{devotional.talkQuestion}</p></div><label className="dv-formlabel">Sua reflexão pessoal <span>· só você pode ler</span><textarea rows={6} value={reflection} maxLength={5000} onChange={(e) => setReflection(e.target.value)} placeholder="Escreva sem pressa. O que essa palavra despertou em você?" /></label><div className="dv-readingfooter"><button className="dv-subtle" disabled={busy} onClick={() => void saveJournal()}><Check size={17} /> Salvar no diário</button><button className="dv-primary" onClick={() => { void saveJournal(); if (!progress.reflect_done) void updateProgress("reflect_done"); setReadingStep(2); }}>Continuar para oração <ChevronRight size={17} /></button></div></section>}
          {readingStep === 2 && <section className="dv-readingcard dv-prayer"><div className="dv-readingicon"><Heart size={23} /></div><span className="dv-kicker">UM MOMENTO COM DEUS</span><h2>Uma oração para hoje</h2><blockquote>{devotional.prayer}</blockquote><div className="dv-practice"><Leaf size={18} /><p><strong>Leve para o seu dia</strong><br />{devotional.practice}</p></div><div className="dv-readingfooter"><button className="dv-subtle" onClick={() => copy(devotional.prayer)}><Copy size={16} /> Copiar oração</button><button className="dv-primary" onClick={() => { if (!progress.pray_done) void updateProgress("pray_done"); setReadingStep(3); }}>Amém, continuar <ChevronRight size={17} /></button></div></section>}
          {readingStep === 3 && <section className="dv-readingcard"><div className="dv-readingicon"><Mail size={23} /></div><span className="dv-kicker">NOSSO ESPAÇO</span><h2>Palavras para guardar</h2><p>O que você viveu hoje merece ser lembrado. Escreva um resumo e, se desejar, uma mensagem especial. Seus rascunhos são somente seus.</p><label className="dv-formlabel">Resumo de hoje <span>· o que aprendi</span><textarea rows={5} maxLength={3000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Hoje entendi que..." /></label><label className="dv-formlabel">Uma mensagem para você <span>· uma palavra do coração</span><textarea rows={5} maxLength={3000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Quero te dizer que..." /></label><p className="dv-privacy"><LockKeyhole size={15} /> Nada é compartilhado sem sua escolha.</p><div className="dv-readingfooter"><button className="dv-subtle" disabled={busy} onClick={() => void saveNote(false)}><Check size={17} /> {myNote?.status === "shared" ? "Salvar edição" : "Salvar rascunho"}</button><button className="dv-primary" disabled={busy || !partner} onClick={() => void saveNote(true)}><Send size={16} /> {myNote?.status === "shared" ? "Atualizar mensagem" : "Compartilhar"}</button></div>{!partner && <p className="dv-muted">Para compartilhar, conecte alguém em <button className="dv-inline" onClick={() => go("perfil")}>Perfil e convites</button>.</p>}{myNote?.status === "shared" && <div className="dv-sent"><Check size={18} /> Sua mensagem foi compartilhada.</div>}{partner && otherNote && myNote?.status === "shared" && <NoteCard note={otherNote} name={partner.name} replies={replies.filter((r) => r.note_id === otherNote.id)} me={user.id} replyText={replyText[otherNote.id] ?? ""} onChangeReply={(t) => setReplyText((r) => ({ ...r, [otherNote.id]: t }))} onReply={() => void sendReply(otherNote.id)} />}</section>}
        </>}
        {page === "diario" && <><div className="dv-pagehead"><span className="dv-kicker">UM LUGAR SÓ SEU</span><h1>Meu diário</h1><p>Palavras que você pode guardar sem precisar explicar a ninguém.</p></div><div className="dv-softcard"><div className="dv-row-between"><h3>{prettyDate(day)}</h3><LockKeyhole size={19} /></div><p className="dv-muted">Sua reflexão pessoal sobre “{devotional.title}”.</p><textarea className="dv-bigtext" rows={9} maxLength={5000} value={reflection} onChange={(e) => setReflection(e.target.value)} placeholder="Escreva aqui o que gostaria de lembrar..." /><div className="dv-readingfooter"><span className="dv-muted">Somente você tem acesso a este texto.</span><button className="dv-primary" disabled={busy} onClick={() => void saveJournal()}>Salvar reflexão <Check size={17} /></button></div></div><h3 className="dv-subheading">Revisitar outros dias</h3><HistoryList history={history} onSelect={(d) => { setDay(d); go("diario"); }} /></>}
        {page === "mensagens" && <><div className="dv-pagehead"><span className="dv-kicker">ENTRE NÓS</span><h1>Mensagens que ficam</h1><p>As palavras que foram compartilhadas com carinho, reunidas num só lugar.</p></div>{!partner ? <Empty icon={Mail} title="Uma história começa com um convite." body="Quando vocês estiverem conectados, as mensagens compartilhadas aparecerão aqui." action="Criar ou aceitar convite" onClick={() => go("perfil")} /> : inbox.length === 0 ? <Empty icon={Mail} title="Ainda não há mensagens." body="Depois do devocional de hoje, escreva seu resumo e uma palavra especial." action="Escrever primeira mensagem" onClick={() => { setReadingStep(3); go("leitura"); }} /> : <div className="dv-inbox">{inbox.map((note) => <NoteCard key={note.id} note={note} name={note.author_id === user.id ? "Você" : partner.name} me={user.id} replies={replies.filter((r) => r.note_id === note.id)} replyText={replyText[note.id] ?? ""} onChangeReply={(t) => setReplyText((r) => ({ ...r, [note.id]: t }))} onReply={() => void sendReply(note.id)} />)}</div>}<button className="dv-subtle dv-reload" onClick={() => void loadShared()}><RefreshCw size={16} /> Atualizar mensagens</button></>}
        {page === "jornada" && <><div className="dv-pagehead"><span className="dv-kicker">CADA DIA CONTA</span><h1>Nossa jornada</h1><p>Uma coleção de dias vividos com intenção.</p></div><div className="dv-stats"><div><strong>{history.filter((h) => h.completed_at).length}</strong><span>Devocionais concluídos</span></div><div><strong>{history.length}</strong><span>Dias registrados</span></div><div><strong>{inbox.length}</strong><span>Mensagens compartilhadas</span></div></div><section className="dv-softcard"><h3>Seus dias de luz</h3><p className="dv-muted">Toque em uma data para revisitar a leitura e suas anotações.</p><HistoryList history={history} onSelect={(d) => { setDay(d); setReadingStep(0); go("leitura"); }} /></section></>}
        {page === "perfil" && <><div className="dv-pagehead"><span className="dv-kicker">SEU CANTINHO</span><h1>Perfil e convites</h1><p>Seu nome, seu espaço e as pessoas com quem você compartilha a jornada.</p></div><div className="dv-twocol"><section className="dv-softcard"><div className="dv-readingicon"><UserRound size={23} /></div><h3>Como podemos chamar você?</h3><label className="dv-formlabel">Nome<input value={profileName} maxLength={60} onChange={(e) => setProfileName(e.target.value)} /></label><p className="dv-muted">{localOnly ? "Anotações salvas neste dispositivo, sem necessidade de login." : "Acesso privado e sem senha."}</p><button className="dv-primary" onClick={() => void updateName()} disabled={busy}>Salvar nome <Check size={17} /></button></section><section className="dv-softcard dv-sage"><div className="dv-readingicon"><Heart size={23} /></div><h3>Nosso espaço</h3>{localOnly ? <><p>Para enviar mensagens entre dois dispositivos, é necessário ativar a conexão segura do aplicativo.</p><button className="dv-primary" disabled={busy} onClick={() => void retrySecureAccess()}>Ativar compartilhamento <ChevronRight size={17} /></button></> : partner ? <><p>Seu espaço está conectado com <strong>{partner.name}</strong>.</p><p className="dv-muted"><LockKeyhole size={14} /> As mensagens são privadas para vocês.</p></> : invite ? <><p>Um espaço reservado foi criado. Compartilhe este código para convidar alguém.</p><div className="dv-invite">{invite} <button aria-label="Copiar convite" onClick={() => copy(invite)}><Copy size={18} /></button></div></> : <><p>Crie um espaço privativo para compartilhar reflexões e mensagens com uma pessoa.</p><button className="dv-primary" disabled={busy} onClick={() => void createInvite()}>Criar convite <ChevronRight size={17} /></button></>}{!spaceId && !localOnly && <div className="dv-join"><label className="dv-formlabel">Recebeu um convite?<input value={inviteInput} maxLength={11} onChange={(e) => setInviteInput(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" /></label><button className="dv-subtle" disabled={busy || !inviteInput.trim()} onClick={() => void joinInvite()}>Entrar com código <ChevronRight size={16} /></button></div>}</section></div></>}
      </main>
      <footer className="dv-footer"><Leaf size={16} /> Um dia de cada vez, com fé e intenção. <span>Feito com cuidado ♡</span></footer>
      <nav className="dv-mobile-nav" aria-label="Navegação móvel">{navigation.filter((n) => n.key !== "leitura").map(({ key, label, icon: Icon }) => <button key={key} className={page === key ? "selected" : ""} onClick={() => go(key)}><Icon size={21} /><span>{label === "Nossa jornada" ? "Jornada" : label === "Meu diário" ? "Diário" : label}</span></button>)}</nav>
    </div>
  </div>;
}

function Empty({ icon: Icon, title, body, action, onClick }: { icon: typeof Mail; title: string; body: string; action: string; onClick: () => void }) {
  return <div className="dv-empty"><div className="dv-readingicon"><Icon size={29} /></div><h3>{title}</h3><p>{body}</p><button className="dv-primary" onClick={onClick}>{action} <ChevronRight size={17} /></button></div>;
}
function HistoryList({ history, onSelect }: { history: Array<{ day: string; completed_at: string | null; read_done: boolean }>; onSelect: (day: string) => void }) {
  return history.length ? <div className="dv-history">{history.map((h) => <button key={h.day} onClick={() => onSelect(h.day)}><span className="dv-history-date">{prettyShort(h.day)}</span><span><strong>{devotionFor(h.day).title}</strong><small>{h.completed_at ? "Concluído com carinho" : "Em andamento"}</small></span><span className={h.completed_at ? "dv-history-complete" : "dv-history-pending"}>{h.completed_at ? <Check size={18} /> : <ChevronRight size={18} />}</span></button>)}</div> : <div className="dv-empty-inline">Seu primeiro registro será o começo de uma bonita história. ♡</div>;
}
function NoteCard({ note, name, replies, me, replyText, onChangeReply, onReply }: { note: Note; name: string; replies: Reply[]; me: string; replyText: string; onChangeReply: (v: string) => void; onReply: () => void }) {
  return <article className="dv-message-card"><div className="dv-message-head"><span className="dv-message-avatar"><Heart size={18} /></span><div><strong>{name}</strong><small>{prettyDate(note.day)}{note.edited_at ? " · editado" : ""}</small></div><Mail size={17} /></div>{note.summary && <section><span className="dv-kicker">RESUMO DO DEVOCIONAL</span><p>{note.summary}</p></section>}{note.message && <section><span className="dv-kicker">UMA MENSAGEM PARA VOCÊ</span><blockquote>{note.message}</blockquote></section>}{replies.length > 0 && <div className="dv-replies">{replies.map((r) => <div key={r.id}><strong>{r.author_id === me ? "Você" : name === "Você" ? "Resposta recebida" : name}</strong><p>{r.body}</p></div>)}</div>}<div className="dv-replybox"><MessageCircle size={17} /><input aria-label="Responder mensagem" value={replyText} maxLength={1000} onChange={(e) => onChangeReply(e.target.value)} placeholder="Escrever uma resposta com carinho..." /><button aria-label="Enviar resposta" disabled={!replyText.trim()} onClick={onReply}><Send size={18} /></button></div></article>;
}
