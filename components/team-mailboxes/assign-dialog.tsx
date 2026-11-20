"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
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
  /** Escape, Cancel, an outside click, and after a pick. The focus goes back to the opener. */
  onClose: () => void;
  /** One click (or Enter) on a person: the caller assigns (stores/team-mailbox-store.ts assign, with this person). */
  onPick: (person: AssignablePerson) => void;
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
 * where the administrator allows lookups. One click on a person picks them
 * and closes. A combobox over a listbox: the arrow keys move, Enter picks.
 */
export function AssignDialog({ isOpen, onClose, onPick, team, client }: AssignDialogProps) {
  const t = useTranslations("team_assign");
  const people = useTeamPeople(team, client);
  const [text, setText] = useState("");
  const [found, setFound] = useState<TeamPerson[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-people`;
  const query = text.trim().toLowerCase();

  // A dialog opened again starts empty.
  useEffect(() => {
    if (!isOpen) {
      setText("");
      setFound([]);
      setActive(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || query.length < MIN_DIRECTORY_SEARCH) {
      setFound([]);
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      void searchDirectory(client, query).then((matches) => {
        if (live) setFound(matches);
      });
    }, DIRECTORY_SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, query, client]);

  const listed = useMemo(() => {
    const out: AssignablePerson[] = [];
    const seen = new Set<string>();
    const add = (p: TeamPerson | null | undefined) => {
      if (!p || !assignable(p) || seen.has(p.id)) return;
      seen.add(p.id);
      out.push(p);
    };
    const self = people.selfId ? people.byId(people.selfId) : null;
    add(self);
    for (const id of people.recent) add(people.byId(id));
    for (const p of people.people) add(p);
    const matches = (p: AssignablePerson) => !query || p.name.toLowerCase().includes(query) || p.email.includes(query);
    const local = out.filter(matches);
    for (const p of found) {
      if (p.id && !seen.has(p.id) && matches(p as AssignablePerson)) {
        seen.add(p.id);
        local.push(p as AssignablePerson);
      }
    }
    return local;
  }, [people, found, query]);

  const current = Math.min(active, Math.max(0, listed.length - 1));

  useEffect(() => {
    if (!isOpen) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [current, isOpen]);

  const pick = (person: AssignablePerson) => {
    onPick(person);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(current + 1, listed.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const person = listed[current];
      if (person) pick(person);
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
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
      }
    >
      <label htmlFor={searchId} className="block text-sm font-medium text-foreground mb-1.5">
        {t("search_label")}
      </label>
      <Input
        id={searchId}
        type="text"
        role="combobox"
        aria-expanded={true}
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
          aria-label={t("people")}
          className="mt-3 max-h-[50vh] overflow-y-auto -mx-2"
        >
          {listed.map((person, index) => {
            const me = person.id === people.selfId;
            return (
              <li
                key={person.id}
                id={`${baseId}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === current}
                onMouseMove={() => {
                  if (index !== current) setActive(index);
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(person)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-2 min-h-11 cursor-pointer select-none",
                  index === current ? "bg-muted" : ""
                )}
              >
                <Avatar name={person.name} email={person.email} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium text-foreground">{person.name || person.email}</span>
                    {me && <span className="shrink-0 text-xs text-muted-foreground">({t("you")})</span>}
                  </span>
                  {person.email && person.email !== person.name && (
                    <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t("no_one_found")}
        </p>
      )}
    </Dialog>
  );
}
