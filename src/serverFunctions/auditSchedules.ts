import { createServerFn } from "@tanstack/react-start";
import { AuditScheduleService } from "@/server/features/audit-schedules/services/AuditScheduleService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getAuditScheduleHistorySchema,
  getAuditScheduleSchema,
  setAuditScheduleActiveSchema,
  upsertAuditScheduleSchema,
} from "@/types/schemas/audit";

export const getAuditSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditScheduleSchema)
  .handler(async ({ context }) => {
    return AuditScheduleService.getSchedule(context.projectId);
  });

export const upsertAuditSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(upsertAuditScheduleSchema)
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, ...schedule } = data;
    return AuditScheduleService.upsertSchedule({
      projectId: context.projectId,
      billingCustomer: context,
      schedule,
    });
  });

export const setAuditScheduleActive = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setAuditScheduleActiveSchema)
  .handler(async ({ data, context }) => {
    return AuditScheduleService.setActive(context.projectId, data.isActive);
  });

export const getAuditScheduleHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditScheduleHistorySchema)
  .handler(async ({ context }) => {
    return AuditScheduleService.getHistory(context.projectId);
  });
