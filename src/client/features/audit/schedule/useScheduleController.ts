import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getAuditSchedule,
  getAuditScheduleHistory,
  setAuditScheduleActive,
  upsertAuditSchedule,
} from "@/serverFunctions/auditSchedules";
import { MIN_PAGES } from "@/client/features/audit/launch/types";
import {
  createFormValidationErrors,
  shouldValidateFieldOnChange,
} from "@/client/lib/forms";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { DEFAULT_AUDIT_PAGES } from "@/shared/audit-limits";

export type AuditSchedule = Awaited<ReturnType<typeof getAuditSchedule>>;
export type AuditScheduleRun = Awaited<
  ReturnType<typeof getAuditScheduleHistory>
>[number];

type ScheduleFormValues = {
  startUrl: string;
  quickEnabled: boolean;
  quickMaxPagesInput: string;
  quickHourUtc: string;
  deepEnabled: boolean;
  deepMaxPagesInput: string;
  deepDowUtc: string;
  deepHourUtc: string;
  deepLighthouse: boolean;
};

/** Defaults mirror the schedule table's column defaults. */
function scheduleFormValues(
  schedule: AuditSchedule,
  fallbackStartUrl: string,
): ScheduleFormValues {
  return {
    startUrl: schedule?.startUrl ?? fallbackStartUrl,
    quickEnabled: schedule?.quickEnabled ?? true,
    quickMaxPagesInput: String(schedule?.quickMaxPages ?? DEFAULT_AUDIT_PAGES),
    quickHourUtc: String(schedule?.quickHourUtc ?? 3),
    deepEnabled: schedule?.deepEnabled ?? true,
    deepMaxPagesInput: String(schedule?.deepMaxPages ?? 500),
    deepDowUtc: String(schedule?.deepDowUtc ?? 1),
    deepHourUtc: String(schedule?.deepHourUtc ?? 4),
    deepLighthouse: schedule?.deepLighthouse ?? false,
  };
}

export function useScheduleQueries(projectId: string) {
  const scheduleQuery = useQuery({
    queryKey: ["audit-schedule", projectId],
    queryFn: () => getAuditSchedule({ data: { projectId } }),
  });
  const historyQuery = useQuery({
    queryKey: ["audit-schedule-history", projectId],
    queryFn: () => getAuditScheduleHistory({ data: { projectId } }),
  });
  return { scheduleQuery, historyQuery };
}

/**
 * Form + mutations for the Schedule panel. `defaultValues` are read once at
 * mount, so the caller renders this only after the schedule query resolves —
 * that keeps the loaded row and the form in step without a reset effect.
 */
export function useScheduleController({
  projectId,
  schedule,
  fallbackStartUrl,
  maxPagesLimit,
  onSaved,
}: {
  projectId: string;
  schedule: AuditSchedule;
  fallbackStartUrl: string;
  maxPagesLimit: number;
  onSaved: () => void;
}) {
  const saveMutation = useMutation({
    mutationFn: (values: ScheduleFormValues) =>
      upsertAuditSchedule({
        data: {
          projectId,
          startUrl: values.startUrl,
          quickEnabled: values.quickEnabled,
          quickMaxPages: clampPages(values.quickMaxPagesInput, maxPagesLimit),
          quickHourUtc: Number(values.quickHourUtc),
          deepEnabled: values.deepEnabled,
          deepMaxPages: clampPages(values.deepMaxPagesInput, maxPagesLimit),
          deepDowUtc: Number(values.deepDowUtc),
          deepHourUtc: Number(values.deepHourUtc),
          deepLighthouse: values.deepLighthouse,
        },
      }),
  });

  const activeMutation = useMutation({
    mutationFn: (isActive: boolean) =>
      setAuditScheduleActive({ data: { projectId, isActive } }),
    onSuccess: (updated) => {
      onSaved();
      toast.success(updated?.isActive ? "Schedule resumed" : "Schedule paused");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to update schedule")),
  });

  const scheduleForm = useForm({
    defaultValues: scheduleFormValues(schedule, fallbackStartUrl),
    validators: {
      onChange: ({ formApi, value }) =>
        getScheduleValidationErrors(
          value,
          shouldValidateFieldOnChange(formApi, "startUrl"),
        ),
      onSubmit: ({ value }) => getScheduleValidationErrors(value, true),
    },
    onSubmit: async ({ formApi, value }) => {
      formApi.setErrorMap({ onSubmit: undefined });
      try {
        await saveMutation.mutateAsync(value);
        onSaved();
        toast.success("Schedule saved");
      } catch (error) {
        formApi.setErrorMap({
          onSubmit: createFormValidationErrors({
            form: getStandardErrorMessage(error, "Failed to save schedule"),
          }),
        });
      }
    },
  });

  return {
    scheduleForm,
    maxPagesLimit,
    isPaused: schedule?.isActive === false,
    togglePaused: () => activeMutation.mutate(schedule?.isActive === false),
    isTogglingPaused: activeMutation.isPending,
    commitPagesInput: (field: "quickMaxPagesInput" | "deepMaxPagesInput") => {
      const clamped = clampPages(
        scheduleForm.state.values[field],
        maxPagesLimit,
      );
      scheduleForm.setFieldValue(field, String(clamped));
    },
  };
}

function getScheduleValidationErrors(
  value: ScheduleFormValues,
  shouldValidateUntouchedField: boolean,
) {
  if (!value.quickEnabled && !value.deepEnabled) {
    return createFormValidationErrors({
      form: "Enable at least one cadence, or pause the schedule.",
    });
  }
  if (value.startUrl.trim() || !shouldValidateUntouchedField) return null;
  return createFormValidationErrors({
    fields: { startUrl: "Please enter a URL." },
  });
}

function clampPages(input: string, maxPagesLimit: number) {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) return MIN_PAGES;
  return Math.max(MIN_PAGES, Math.min(maxPagesLimit, Math.round(parsed)));
}
