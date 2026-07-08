"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Users, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";

interface ContactGroupListProps {
  groups: ContactCard[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onCreateGroup: () => void;
  searchQuery: string;
  className?: string;
}

export function ContactGroupList({
  groups,
  selectedGroupId,
  onSelectGroup,
  onCreateGroup,
  searchQuery,
  className,
}: ContactGroupListProps) {
  const t = useTranslations("contacts");

  const filtered = useMemo(() => {
    if (!searchQuery) return groups;
    const lower = searchQuery.toLowerCase();
    return groups.filter((g) =>
      getContactDisplayName(g).toLowerCase().includes(lower)
    );
  }, [groups, searchQuery]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) =>
      getContactDisplayName(a).localeCompare(getContactDisplayName(b))
    );
  }, [filtered]);

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="px-4 py-2 border-b border-border">
        <Button size="sm" variant="outline" onClick={onCreateGroup} className="w-full">
          <Plus className="w-4 h-4 me-1" />
          {t("groups.create")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground px-4">
            <Users className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm">
              {searchQuery ? t("empty_search") : t("groups.empty")}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sorted.map((group) => {
              const memberCount = group.members
                ? Object.values(group.members).filter(Boolean).length
                : 0;
              return (
                <button
                  key={group.id}
                  onClick={() => onSelectGroup(group.id)}
                  className={cn(
                    "w-full flex items-center px-4 text-start transition-colors",
                    "hover:bg-muted",
                    group.id === selectedGroupId && "bg-accent text-accent-foreground"
                  )}
                  style={{ gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-item-py)' }}
                >
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Users className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {getContactDisplayName(group)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("groups.member_count", { count: memberCount })}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
