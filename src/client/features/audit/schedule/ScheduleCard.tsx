import { Loader2 } from "lucide-react";
import { MIN_PAGES } from "@/client/features/audit/launch/types";
import {
  useScheduleController,
  type AuditSchedule,
} from "@/client/features/audit/schedule/useScheduleController";
import { getFieldError, getFormError } from "@/client/lib/forms";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

type Controller = ReturnType<typeof useScheduleController>;

export function ScheduleCard({
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
  const controller = useScheduleController({
    projectId,
    schedule,
    fallbackStartUrl,
    maxPagesLimit,
    onSaved,
  });
  const { scheduleForm } = controller;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h2 className="card-title text-base">Schedule</h2>
            <p className="text-xs text-base-content/60">
              {nextRunSummary(schedule, controller.isPaused)}
            </p>
          </div>
          {schedule ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={controller.isTogglingPaused}
              onClick={controller.togglePaused}
            >
              {controller.isPaused ? "Resume" : "Pause"}
            </button>
          ) : null}
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void scheduleForm.handleSubmit();
          }}
        >
          <scheduleForm.Field name="startUrl">
            {(field) => {
              const error = getFieldError(field.state.meta.errors);
              return (
                <label className="space-y-1 block">
                  <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
                    Start URL
                  </span>
                  <input
                    className={`input input-bordered w-full ${error ? "input-error" : ""}`}
                    placeholder="https://example.com"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  {error ? (
                    <span className="text-sm text-error">{error}</span>
                  ) : null}
                </label>
              );
            }}
          </scheduleForm.Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <QuickCadence controller={controller} />
            <DeepCadence controller={controller} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-base-content/50">
              Times are UTC. Scheduled crawls are archived to cold storage and
              scored on the same 0&ndash;100 Site Health scale.
            </p>
            <scheduleForm.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <button
                  type="submit"
                  className="btn btn-primary btn-sm shrink-0"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Saving...
                    </>
                  ) : (
                    "Save schedule"
                  )}
                </button>
              )}
            </scheduleForm.Subscribe>
          </div>

          <scheduleForm.Subscribe selector={(state) => state.errorMap}>
            {(errorMap) => {
              const message =
                getFormError(errorMap.onSubmit) ??
                getFormError(errorMap.onChange);
              return message ? (
                <div className="alert alert-error py-2">
                  <span className="text-sm">{message}</span>
                </div>
              ) : null;
            }}
          </scheduleForm.Subscribe>
        </form>
      </div>
    </div>
  );
}

function QuickCadence({ controller }: { controller: Controller }) {
  const { scheduleForm } = controller;
  return (
    <fieldset className="rounded-lg border border-base-300 bg-base-200/20 p-3 space-y-2">
      <label className="label cursor-pointer justify-start gap-2 p-0">
        <scheduleForm.Field name="quickEnabled">
          {(field) => (
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
          )}
        </scheduleForm.Field>
        <span className="text-sm font-medium text-base-content/80">
          Daily quick crawl
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-base-content/70">Max pages</span>
        <scheduleForm.Field name="quickMaxPagesInput">
          {(field) => (
            <input
              type="number"
              min={MIN_PAGES}
              max={controller.maxPagesLimit}
              className="input input-bordered input-sm w-24"
              value={field.state.value}
              onChange={(event) => {
                if (!/^\d*$/.test(event.target.value)) return;
                field.handleChange(event.target.value);
              }}
              onBlur={() => controller.commitPagesInput("quickMaxPagesInput")}
            />
          )}
        </scheduleForm.Field>
        <span className="text-sm text-base-content/70">at</span>
        <scheduleForm.Field name="quickHourUtc">
          {(field) => (
            <HourSelect
              value={field.state.value}
              onChange={(value) => field.handleChange(value)}
            />
          )}
        </scheduleForm.Field>
      </div>
    </fieldset>
  );
}

function DeepCadence({ controller }: { controller: Controller }) {
  const { scheduleForm } = controller;
  return (
    <fieldset className="rounded-lg border border-base-300 bg-base-200/20 p-3 space-y-2">
      <label className="label cursor-pointer justify-start gap-2 p-0">
        <scheduleForm.Field name="deepEnabled">
          {(field) => (
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
          )}
        </scheduleForm.Field>
        <span className="text-sm font-medium text-base-content/80">
          Weekly deep crawl
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-base-content/70">Max pages</span>
        <scheduleForm.Field name="deepMaxPagesInput">
          {(field) => (
            <input
              type="number"
              min={MIN_PAGES}
              max={controller.maxPagesLimit}
              className="input input-bordered input-sm w-24"
              value={field.state.value}
              onChange={(event) => {
                if (!/^\d*$/.test(event.target.value)) return;
                field.handleChange(event.target.value);
              }}
              onBlur={() => controller.commitPagesInput("deepMaxPagesInput")}
            />
          )}
        </scheduleForm.Field>
        <scheduleForm.Field name="deepDowUtc">
          {(field) => (
            <select
              className="select select-bordered select-sm"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            >
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={String(index)}>
                  {day}
                </option>
              ))}
            </select>
          )}
        </scheduleForm.Field>
        <scheduleForm.Field name="deepHourUtc">
          {(field) => (
            <HourSelect
              value={field.state.value}
              onChange={(value) => field.handleChange(value)}
            />
          )}
        </scheduleForm.Field>
      </div>

      <label className="label cursor-pointer justify-start gap-2 p-0">
        <scheduleForm.Field name="deepLighthouse">
          {(field) => (
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
          )}
        </scheduleForm.Field>
        <span className="text-sm text-base-content/70">
          Include Lighthouse on deep crawls
        </span>
      </label>
    </fieldset>
  );
}

function HourSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="select select-bordered select-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Hour (UTC)"
    >
      {HOURS.map((hour) => (
        <option key={hour} value={String(hour)}>
          {String(hour).padStart(2, "0")}:00 UTC
        </option>
      ))}
    </select>
  );
}

function nextRunSummary(schedule: AuditSchedule, isPaused: boolean): string {
  if (!schedule) {
    return "Crawl this site automatically and track its health score over time.";
  }
  if (isPaused) return "Paused — no crawls will run until you resume.";

  const { nextQuickAt, nextDeepAt } = schedule;
  // ISO-8601 strings compare lexicographically, so this is the earlier slot.
  const next =
    nextQuickAt && nextDeepAt
      ? nextQuickAt < nextDeepAt
        ? nextQuickAt
        : nextDeepAt
      : (nextQuickAt ?? nextDeepAt);
  if (!next) return "No cadence enabled.";
  return `Next crawl ${new Date(next).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
