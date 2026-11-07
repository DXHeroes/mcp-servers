import { type ApiKeyConfig, callSignal } from '@dxheroes/mcp-kit';
import { z } from 'zod';
import { GraphApiError, type GraphClient, GraphInputError } from './client.js';
import {
  type Args,
  id,
  itemBody,
  type Operation,
  OutlookServer,
  page,
  pick,
  recipient,
  time,
} from './server.js';

const showAs = z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']);
const weekday = z.enum([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);
const recurrence = z
  .object({
    pattern: z
      .object({
        type: z.enum([
          'daily',
          'weekly',
          'absoluteMonthly',
          'relativeMonthly',
          'absoluteYearly',
          'relativeYearly',
        ]),
        interval: z.number().int().min(1).max(999),
        daysOfWeek: z.array(weekday).min(1).max(7).optional(),
        dayOfMonth: z.number().int().min(1).max(31).optional(),
        month: z.number().int().min(1).max(12).optional(),
        index: z.enum(['first', 'second', 'third', 'fourth', 'last']).optional(),
        firstDayOfWeek: weekday.optional(),
      })
      .strict(),
    range: z
      .object({
        type: z.enum(['endDate', 'noEnd', 'numbered']),
        startDate: z.iso.date(),
        endDate: z.iso.date().optional(),
        numberOfOccurrences: z.number().int().min(1).max(999).optional(),
        recurrenceTimeZone: z.string().max(100).optional(),
      })
      .strict(),
  })
  .strict();
const fields = {
  subject: z.string().max(4096).optional(),
  body: itemBody.optional(),
  start: time.optional(),
  end: time.optional(),
  location: z
    .object({ displayName: z.string().max(1024) })
    .strict()
    .optional(),
  attendees: z
    .array(recipient.extend({ type: z.enum(['required', 'optional', 'resource']) }))
    .max(500)
    .optional(),
  isAllDay: z.boolean().optional(),
  isReminderOn: z.boolean().optional(),
  reminderMinutesBeforeStart: z.number().int().min(0).max(40320).optional(),
  showAs: showAs.optional(),
  sensitivity: z.enum(['normal', 'personal', 'private', 'confidential']).optional(),
  responseRequested: z.boolean().optional(),
  categories: z.array(z.string().max(255)).max(25).optional(),
  recurrence: recurrence.nullable().optional(),
  transactionId: z.string().min(1).max(255).optional(),
  isOnlineMeeting: z.boolean().optional(),
  onlineMeetingProvider: z
    .enum(['teamsForBusiness', 'skypeForBusiness', 'skypeForConsumer'])
    .optional(),
};
const range = {
  startDateTime: z.iso.datetime({ offset: true }),
  endDateTime: z.iso.datetime({ offset: true }),
};
const validRange = (a: { startDateTime: string; endDateTime: string }) =>
  Date.parse(a.endDateTime) > Date.parse(a.startDateTime);
const events = (a: Args) =>
  a.calendarId ? `me/calendars/${encodeURIComponent(String(a.calendarId))}/events` : 'me/events';
const event = (a: Args) => `${events(a)}/${encodeURIComponent(String(a.eventId))}`;
const eventView = (a: Args) =>
  a.calendarId
    ? `me/calendars/${encodeURIComponent(String(a.calendarId))}/calendarView`
    : 'me/calendarView';
async function freeBusy(a: Args, client: GraphClient): Promise<Record<string, unknown>> {
  let own: Set<string> | undefined;
  async function identity() {
    if (own) return own;
    const p = await client.request('GET', 'me', { $select: 'mail,userPrincipalName' });
    own = new Set(
      [p.mail, p.userPrincipalName]
        .filter((s): s is string => typeof s === 'string' && z.email().safeParse(s).success)
        .map((s) => s.toLowerCase()),
    );
    return own;
  }
  const schedules = (a.schedules as string[] | undefined) ?? [...(await identity())].slice(0, 1);
  if (!schedules.length) throw new GraphInputError();
  try {
    return await client.request(
      'POST',
      'me/calendar/getSchedule',
      {},
      {
        schedules,
        startTime: {
          dateTime: new Date(String(a.startDateTime)).toISOString().slice(0, -1),
          timeZone: 'UTC',
        },
        endTime: {
          dateTime: new Date(String(a.endDateTime)).toISOString().slice(0, -1),
          timeZone: 'UTC',
        },
        ...(a.availabilityViewInterval !== undefined
          ? { availabilityViewInterval: a.availabilityViewInterval }
          : {}),
      },
    );
  } catch (error) {
    if (!(error instanceof GraphApiError) || ![400, 403, 404, 501].includes(error.status))
      throw error;
    const self = await identity();
    if (!schedules.every((s) => self.has(s.toLowerCase()))) throw error;
  }
  const scheduleItems: Record<string, unknown>[] = [];
  let nextLink: string | undefined;
  let bytes = 0;
  const seen = new Set<string>();
  for (let count = 0; count < 64; count++) {
    callSignal()?.throwIfAborted();
    const result = await client.request(
      'GET',
      'me/calendarView',
      { ...pick(a, ['startDateTime', 'endDateTime']), $top: 1000 },
      undefined,
      nextLink,
    );
    if (!Array.isArray(result.value)) throw new Error('Invalid calendar response');
    for (const item of result.value) {
      const e = z
        .object({
          isCancelled: z.boolean().optional(),
          showAs: showAs.optional(),
          start: time.optional(),
          end: time.optional(),
        })
        .passthrough()
        .parse(item);
      if (e.isCancelled || e.showAs === 'free') continue;
      if (!e.start || !e.end) throw new Error('Invalid event interval');
      const row = { status: e.showAs ?? 'unknown', start: e.start, end: e.end };
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 2 * 1024 * 1024 || scheduleItems.length >= 10000)
        throw new Error('Calendar exceeds size limit');
      scheduleItems.push(row);
    }
    if (result['@odata.nextLink'] === undefined)
      return {
        source: 'calendarView',
        scope: 'self',
        scheduleId: schedules[0],
        scheduleItems,
        limitations: [
          'Only the current account default calendar is included; no availability for other people or resources.',
        ],
      };
    if (typeof result['@odata.nextLink'] !== 'string' || seen.has(result['@odata.nextLink']))
      throw new Error('Invalid calendar pagination');
    nextLink = result['@odata.nextLink'];
    seen.add(nextLink);
  }
  throw new Error('Calendar page limit exceeded');
}
const operations: Operation[] = [
  {
    name: 'calendar_list_calendars',
    description: 'List one page of the delegated user calendars.',
    schema: z.object(page).strict(),
    method: 'GET',
    path: () => 'me/calendars',
    query: (a) => ({ $top: a.top }),
    read: true,
  },
  {
    name: 'calendar_list_events',
    description:
      'List one page of events, including recurrence occurrences and exceptions, in a time range.',
    schema: z
      .object({
        ...range,
        ...page,
        calendarId: id.optional(),
        select: z.string().max(2048).optional(),
      })
      .strict()
      .refine(validRange, 'End must follow start'),
    method: 'GET',
    path: eventView,
    query: (a) => ({
      ...pick(a, ['startDateTime', 'endDateTime']),
      $top: a.top,
      $select: a.select,
    }),
    read: true,
  },
  {
    name: 'calendar_get_event',
    description: 'Read an event by ID.',
    schema: z.object({ eventId: id, calendarId: id.optional() }).strict(),
    method: 'GET',
    path: event,
    read: true,
  },
  {
    name: 'calendar_create_event',
    description:
      'Create an event in the selected or default calendar. Attendees receive invitations according to Microsoft behavior.',
    schema: z
      .object({
        calendarId: id.optional(),
        ...fields,
        subject: z.string().min(1).max(4096),
        start: time,
        end: time,
      })
      .strict(),
    method: 'POST',
    path: events,
    body: Object.keys(fields),
  },
  {
    name: 'calendar_update_event',
    description: 'Update event fields, preserving omitted values. Updates may notify attendees.',
    schema: z
      .object({ calendarId: id.optional(), eventId: id, ...fields })
      .strict()
      .refine((a) => Object.keys(fields).some((k) => k in a), 'Supply a field to update'),
    method: 'PATCH',
    path: event,
    body: Object.keys(fields),
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete an event; deleting as organizer cancels the meeting for attendees.',
    schema: z.object({ calendarId: id.optional(), eventId: id }).strict(),
    method: 'DELETE',
    path: event,
    destructive: true,
  },
  {
    name: 'calendar_respond_to_invitation',
    description: 'Accept, tentatively accept or decline a meeting invitation.',
    schema: z
      .object({
        calendarId: id.optional(),
        eventId: id,
        response: z.enum(['accept', 'tentativelyAccept', 'decline']),
        comment: z.string().max(8192).optional(),
        sendResponse: z.boolean().optional(),
      })
      .strict(),
    method: 'POST',
    path: (a) => `${event(a)}/${a.response}`,
    body: ['comment', 'sendResponse'],
  },
  {
    name: 'calendar_get_free_busy',
    description:
      'Get free/busy for up to 20 schedules, for less than 62 days. If getSchedule is unavailable, only the current account can fall back to its complete default calendarView, with explicit scope and limitations.',
    schema: z
      .object({
        ...range,
        schedules: z.array(z.email()).min(1).max(20).optional(),
        availabilityViewInterval: z.number().int().min(5).max(1440).optional(),
      })
      .strict()
      .refine(
        (a) =>
          validRange(a) && Date.parse(a.endDateTime) - Date.parse(a.startDateTime) < 62 * 86400000,
        'Use an increasing range shorter than 62 days',
      ),
    run: freeBusy,
    read: true,
  },
];
export class OutlookCalendarServer extends OutlookServer {
  constructor(credential: ApiKeyConfig | null) {
    super(credential, operations);
  }
}
