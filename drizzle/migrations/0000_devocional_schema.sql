CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL,
  invite_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.spaces TO authenticated;
GRANT ALL ON public.spaces TO service_role;
ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.space_members (
  space_id uuid NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL UNIQUE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);
GRANT SELECT ON public.space_members TO authenticated;
GRANT ALL ON public.space_members TO service_role;
ALTER TABLE public.space_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.my_space_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT space_id FROM public.space_members WHERE user_id = auth.uid() LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.shares_space_with(_other uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.space_members a JOIN public.space_members b ON a.space_id = b.space_id
    WHERE a.user_id = auth.uid() AND b.user_id = _other
  )
$$;

CREATE POLICY "own or partner profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.shares_space_with(id));
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "members see space" ON public.spaces FOR SELECT TO authenticated
  USING (id = public.my_space_id());
CREATE POLICY "members see members" ON public.space_members FOR SELECT TO authenticated
  USING (space_id = public.my_space_id());

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, left(coalesce(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)), 60))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.create_space()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _code text; _sid uuid; _raw text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT s.invite_code INTO _code FROM public.space_members m JOIN public.spaces s ON s.id = m.space_id WHERE m.user_id = _uid;
  IF _code IS NOT NULL THEN RETURN _code; END IF;
  LOOP
    _raw := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    _code := substr(_raw, 1, 5) || '-' || substr(_raw, 6, 5);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.spaces WHERE invite_code = _code);
  END LOOP;
  INSERT INTO public.spaces (created_by, invite_code) VALUES (_uid, _code) RETURNING id INTO _sid;
  INSERT INTO public.space_members (space_id, user_id) VALUES (_sid, _uid);
  RETURN _code;
END $$;

CREATE OR REPLACE FUNCTION public.join_space(_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _sid uuid; _n int;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.space_members WHERE user_id = _uid) THEN RAISE EXCEPTION 'already_in_space'; END IF;
  SELECT id INTO _sid FROM public.spaces WHERE invite_code = upper(trim(_code)) FOR UPDATE;
  IF _sid IS NULL THEN RAISE EXCEPTION 'invalid_code'; END IF;
  SELECT count(*) INTO _n FROM public.space_members WHERE space_id = _sid;
  IF _n >= 2 THEN RAISE EXCEPTION 'space_full'; END IF;
  INSERT INTO public.space_members (space_id, user_id) VALUES (_sid, _uid);
  RETURN _sid;
END $$;

-- Only the creator alone may leave (dissolve) an unpaired space
CREATE OR REPLACE FUNCTION public.leave_unpaired_space()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _sid uuid := public.my_space_id();
BEGIN
  IF _sid IS NULL THEN RETURN; END IF;
  IF (SELECT count(*) FROM public.space_members WHERE space_id = _sid) > 1 THEN RAISE EXCEPTION 'space_paired'; END IF;
  DELETE FROM public.spaces WHERE id = _sid;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_space(), public.join_space(text), public.leave_unpaired_space(), public.my_space_id(), public.shares_space_with(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_space(), public.join_space(text), public.leave_unpaired_space(), public.my_space_id(), public.shares_space_with(uuid) TO authenticated;

CREATE TABLE public.daily_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  day date NOT NULL,
  devotional_id int NOT NULL,
  read_done boolean NOT NULL DEFAULT false,
  reflect_done boolean NOT NULL DEFAULT false,
  pray_done boolean NOT NULL DEFAULT false,
  commitment_done boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
GRANT SELECT, INSERT, UPDATE ON public.daily_progress TO authenticated;
GRANT ALL ON public.daily_progress TO service_role;
ALTER TABLE public.daily_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "see own or partner progress" ON public.daily_progress FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.shares_space_with(user_id));
CREATE POLICY "insert own progress" ON public.daily_progress FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "update own progress" ON public.daily_progress FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  day date NOT NULL,
  reflection text NOT NULL DEFAULT '' CHECK (char_length(reflection) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entries TO authenticated;
GRANT ALL ON public.journal_entries TO service_role;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own journal" ON public.journal_entries FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.shared_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL DEFAULT auth.uid(),
  space_id uuid REFERENCES public.spaces(id) ON DELETE SET NULL,
  day date NOT NULL,
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 3000),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 3000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared')),
  shared_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, day)
);
GRANT SELECT, INSERT, UPDATE ON public.shared_notes TO authenticated;
GRANT ALL ON public.shared_notes TO service_role;
ALTER TABLE public.shared_notes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_shared_on(_day date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.shared_notes WHERE author_id = auth.uid() AND day = _day AND status = 'shared')
$$;
REVOKE EXECUTE ON FUNCTION public.has_shared_on(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_shared_on(date) TO authenticated;

CREATE POLICY "author sees own notes" ON public.shared_notes FOR SELECT TO authenticated USING (author_id = auth.uid());
CREATE POLICY "partner sees shared after sharing" ON public.shared_notes FOR SELECT TO authenticated
  USING (status = 'shared' AND space_id IS NOT NULL AND space_id = public.my_space_id() AND public.has_shared_on(day));
CREATE POLICY "author inserts notes" ON public.shared_notes FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
CREATE POLICY "author updates notes" ON public.shared_notes FOR UPDATE TO authenticated USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid());

CREATE OR REPLACE FUNCTION public.shared_notes_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.day > (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1 THEN RAISE EXCEPTION 'future_day'; END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.author_id := OLD.author_id;
    NEW.day := OLD.day;
    IF OLD.status = 'shared' THEN
      NEW.status := 'shared';
      NEW.space_id := OLD.space_id;
      NEW.shared_at := OLD.shared_at;
      IF NEW.summary IS DISTINCT FROM OLD.summary OR NEW.message IS DISTINCT FROM OLD.message THEN NEW.edited_at := now(); END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.status = 'shared' THEN
    NEW.space_id := (SELECT space_id FROM public.space_members WHERE user_id = NEW.author_id);
    IF NEW.space_id IS NULL OR (SELECT count(*) FROM public.space_members WHERE space_id = NEW.space_id) < 2 THEN
      RAISE EXCEPTION 'not_paired';
    END IF;
    IF btrim(NEW.summary) = '' AND btrim(NEW.message) = '' THEN RAISE EXCEPTION 'empty_note'; END IF;
    NEW.shared_at := now();
    NEW.edited_at := NULL;
  ELSE
    NEW.space_id := NULL;
    NEW.shared_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_notes_guard BEFORE INSERT OR UPDATE ON public.shared_notes
  FOR EACH ROW EXECUTE FUNCTION public.shared_notes_guard();

CREATE TABLE public.note_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES public.shared_notes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.note_replies TO authenticated;
GRANT ALL ON public.note_replies TO service_role;
ALTER TABLE public.note_replies ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_see_note(_note uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shared_notes n
    WHERE n.id = _note AND n.status = 'shared' AND n.space_id = public.my_space_id()
      AND (n.author_id = auth.uid() OR public.has_shared_on(n.day))
  )
$$;
REVOKE EXECUTE ON FUNCTION public.can_see_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_note(uuid) TO authenticated;

CREATE POLICY "see replies of visible notes" ON public.note_replies FOR SELECT TO authenticated USING (public.can_see_note(note_id));
CREATE POLICY "reply to visible notes" ON public.note_replies FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND public.can_see_note(note_id));
CREATE POLICY "delete own replies" ON public.note_replies FOR DELETE TO authenticated USING (author_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER t_profiles BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_progress BEFORE UPDATE ON public.daily_progress FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_journal BEFORE UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();