"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Check } from "@/components/icons";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { TeamRef } from "@/lib/team-mailboxes/team";
import { MIN_DIRECTORY_SEARCH, searchDirectory, type TeamPerson } from "@/lib/team-mailboxes/names";
import { useTeamPeople } from "@/hooks/use-team-people";
import { cn } from "@/lib/utils";

/** Typing pauses this long before the directory is searched. */
export const DIRECTORY_SEARCH_DELAY_MS = 400;

/** A person "Assign to…" can pick: one with a principal id. */
export interface AssignablePerson {
  id: string;
  name: string;
  email: string;
}

export interface AssignDialogProps {
  isOpen: boolean;
  /** Escape, Cancel, an outside click, and after Save. The focus goes back to the opener. */
  onClose: () => void;
  /**
   * Save: everyone ticked, in the order they were listed (the caller sets
   * exactly these, stores/team-mailbox-store.ts setAssignees). `people`
   * names the ones the dialog knows.
   */
  onSave: (ids: string[], people: Record<string, AssignablePerson>) => void;
  /** The principal ids the message is assigned to now: ticked when the dialog opens. */
  assigned: readonly string[];
  team: TeamRef;
  /** The team's own login. */
  client: IJMAPClient;
}

function assignable(p: TeamPerson): p is AssignablePerson {
  return !!p.id && !!(p.name || p.email);
}

/**
 * "Assign to…": the people of the team, the user first, then the people
 * messages were assigned to lately, the names list and the note authors the
 * team knows, and, from 3 characters, matches from the server's directory
 * where the administrator allows lookups. A click (or Enter) ticks or
 * unticks a person; Save assigns the message to everyone ticked. A
 * combobox over a multi-select listbox: the arrow keys move.
 */
export function AssignDialog({ isOpen, onClose, onSave, assigned, team, client }: AssignDialogProps) {
  const t = useTranslations("team_assign");
  const people = useTeamPeople(team, client);
  const [text, setText] = useState("");
  const [found, setFound] = useState<TeamPerson[]>([]);
  // A directory search under way: "No one found." waits for its answer.
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<string[]>(() => assigned.map((id) => id.toLowerCase()));
  // People ticked from a directory search stay named after the search changes.
  const [picked, setPicked] = useState<Record<string, AssignablePerson>>({});
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-people`;
  const query = text.trim().toLowerCase();
  const assignedKey = assigned.join(" ");

  // A dialog opened again starts from the message as it is.
  useEffect(() => {
    if (!isOpen) {
      setText("");
      setFound([]);
      setActive(0);
      setPicked({});
    } else {
      setChosen(assigned.map((id) => id.toLowerCase()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the ids
  }, [isOpen, assignedKey]);

  useEffect(() => {
    if (!isOpen || query.length < MIN_DIRECTORY_SEARCH) {
      setFound([]);
      setSearching(false);
      return undefined;
    }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchDirectory(client, query).then((matches) => {
        if (live) setFound(matches);
      }).finally(() => {
        if (live) setSearching(false);
      });
    }, DIRECTORY_SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, query, client]);

  /** Someone the message is assigned to whose name nobody knows yet still shows, by id. */
  const personFor = (id: string): AssignablePerson => {
    const known = picked[id] ?? people.byId(id);
    if (known && (known.name || known.email)) return { id, name: known.name ?? "", email: known.email ?? "" };
    return { id, name: "", email: "" };
  };

  const listed = useMemo(() => {
    const out: AssignablePerson[] = [];
    const seen = new Set<string>();
    const add = (p: TeamPerson | AssignablePerson | null | undefined) => {
      if (!p || !p.id || seen.has(p.id)) return;
      if (!assignable(p as TeamPerson) && !chosen.includes(p.id)) return;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name ?? "", email: p.email ?? "" });
    };
    const self = people.selfId ? people.byId(people.selfId) : null;
    add(self);
    for (const id of chosen) add(personFor(id));
    for (const id of people.recent) add(people.byId(id));
    for (const p of people.people) add(p);
    const matches = (p: AssignablePerson) => !query || p.name.toLowerCase().includes(query) || p.email.includes(query) || p.id === query;
    const local = out.filter(matches);
    for (const p of found) {
      if (p.id && !seen.has(p.id) && matches(p as AssignablePerson)) {
        seen.add(p.id);
        local.push(p as AssignablePerson);
      }
    }
    return local;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- personFor reads picked and people
  }, [people, found, query, chosen, picked]);

  const current = Math.min(active, Math.max(0, listed.length - 1));

  useEffect(() => {
    if (!isOpen) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [current, isOpen]);

  const toggle = (person: AssignablePerson) => {
    setChosen((list) => (list.includes(person.id) ? list.filter((id) => id !== person.id) : [...list, person.id]));
    if (person.name || person.email) setPicked((map) => ({ ...map, [person.id]: person }));
  };

  const save = () => {
    const named: Record<string, AssignablePerson> = {};
    for (const id of chosen) {
      const p = personFor(id);
      if (p.name || p.email) named[id] = p;
    }
    onSave([...chosen], named);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.max(0, Math.min(current + 1, listed.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const person = listed[current];
      if (person) toggle(person);
    }
  };

  const activeId = listed.length > 0 ? `${baseId}-option-${current}` : undefined;
  const searchId = `${baseId}-search`;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("dialog_title")}
      size="sm"
      bodyClassName="px-4 sm:px-6"
      testId="team-assign-dialog"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={save} data-testid="team-assign-save">
            {t("save")}
          </Button>
        </>
      }
    >
      <label htmlFor={searchId} className="block text-sm font-medium text-foreground mb-1.5">
        {t("search_label")}
      </label>
      <Input
        id={searchId}
        type="text"
        role="combobox"
        aria-expanded={listed.length > 0}
        aria-controls={listed.length > 0 ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {listed.length > 0 ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t("people")}
          className="mt-3 max-h-[50vh] overflow-y-auto -mx-2"
        >
          {listed.map((person, index) => {
            const me = person.id === people.selfId;
            const on = chosen.includes(person.id);
            const label = person.name || person.email || t("assigned_unknown");
            return (
              <li
                key={person.id}
                id={`${baseId}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={on}
                data-active={index === current ? "" : undefined}
                onMouseMove={() => {
                  if (index !== current) setActive(index);
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(person)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-2 min-h-11 cursor-pointer select-none",
                  index === current ? "bg-muted" : ""
                )}
              >
                <span aria-hidden="true" className="shrink-0"><Avatar name={label} email={person.email} size="sm" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium text-foreground">{label}</span>
                    {me && <span className="shrink-0 text-xs text-muted-foreground">({t("you")})</span>}
                  </span>
                  {person.email && person.email !== person.name && (
                    <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded border",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  )}
                >
                  {on && <Check className="h-3.5 w-3.5" />}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status" className="mt-3 min-h-5 text-sm text-muted-foreground">
          {searching ? null : t("no_one_found")}
        </p>
      )}
    </Dialog>
  );
}
