// Store interface — the shape that store-memory.js and store-d1.js both
// implement, and that handlers.js speaks to exclusively. Handlers see
// no SQL and no D1; tests inject the memory impl. This is the boundary
// that made primitive's Sheets→DB swap a one-file job (PAST.md §3),
// preserved here.
//
// Method groups:
//   people                    -- 30k roster
//   users                     -- ~330 logins
//   groups + group_membership -- NJY & BV structure
//   daily_chant_log           -- Phase-2 daily marks
//   feature_gates             -- RBAC promotion
//   notifications             -- outbox audit
//
// Later phases add: events/attendance, sadhana_entries, group_reports,
// duties, web_push_subscriptions. Stubbed empty in both impls until
// their handlers exist.

export const STORE_METHODS = Object.freeze([
  // people
  "personById", "personByPhone", "peopleInGroup", "personsByStatus",
  "peopleAssignedTo", "peopleCount", "searchPeople",
  "oneMonthDailyCountFor",
  "createPerson", "updatePerson", "bulkCreatePeople",
  "assignPeopleToUser", "deletePerson",
  // users
  "userById", "userByUsername", "listUsersByRole", "listAllUsers",
  "createUser", "updateUser", "nextSlNoFor",
  // groups
  "groupById", "listGroupsByKind", "listGroupsByLeader",
  "listGroupsByParent", "createGroup", "updateGroup", "deleteGroup",
  "membershipsInGroup", "membershipsForPerson", "addMembership", "endMembership",
  // daily chant
  "chantOnDate", "chantsByGroupOnDate", "upsertChant", "hasChantedSince",
  "countChantsOnDate", "countChantDaysForCoord", "chantDatesForPersonIdsBetween",
  "peopleCountByCoord", "chantedCountByCoordOnDate",
  "chantedTodayDailyByCoord", "consistentDailyByCoord",
  "followUpsCountByCoordOnDate",
  "dailyChanterCountByCoord", "oneMonthDailyCountByCoord",
  // events / attendance
  "listEvents", "eventById", "createEvent", "updateEvent", "deleteEvent",
  "attendanceForEvent", "upsertAttendance",
  // sadhana
  "upsertSadhana", "sadhanaFor", "recentSadhana", "sadhanaById", "deleteSadhanaEntry",
  // group reports
  "createGroupReport", "listGroupReports", "groupReportById", "updateGroupReport", "deleteGroupReport",
  // duties
  "dutiesFor", "dutyById", "createDuty", "markDutyDone", "deleteDuty",
  // web push
  "listWebPushSubs", "addWebPushSub", "removeWebPushSub",
  // gates
  "featureGates", "setFeatureGate",
  // notifications
  "recordNotification",
]);

export function assertStoreShape(store) {
  const missing = STORE_METHODS.filter(m => typeof store[m] !== "function");
  if (missing.length) throw new Error(`store missing methods: ${missing.join(", ")}`);
}
