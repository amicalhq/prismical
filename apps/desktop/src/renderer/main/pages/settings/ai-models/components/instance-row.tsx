"use client";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import type { Instance } from "@/db/schema";

interface InstanceRowProps {
  instance: Instance;
  editable: boolean;
  onEdit: () => void;
}

export default function InstanceRow({
  instance,
  editable,
  onEdit,
}: InstanceRowProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = api.useUtils();

  const removeMutation = api.instances.remove.useMutation({
    onSuccess: () => {
      toast.success("Instance removed");
      utils.instances.list.invalidate();
      utils.instances.listByType.invalidate();
      utils.instances.getDefaults.invalidate();
    },
    onError: (error) => {
      toast.error(`Couldn't remove instance: ${error.message}`);
    },
  });

  return (
    <>
      <div className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50">
        <span className="text-sm">{instance.label}</span>
        {editable && (
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onEdit}
              aria-label="Edit"
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
              aria-label="Remove"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {instance.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The instance and any defaults pointing at it will be cleared. You
              can add it again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeMutation.mutate({ id: instance.id })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
