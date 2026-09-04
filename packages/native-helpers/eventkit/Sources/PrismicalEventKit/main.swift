import EventKit
import Foundation

struct PermissionOutput: Codable {
    let authorizationStatus: String
}

struct CalendarOutput: Codable {
    let externalId: String
    let title: String
    let color: String?
    let sourceTitle: String?
    let sourceType: String?
    let allowsContentModifications: Bool
    let primary: Bool
}

struct PartyOutput: Codable {
    let name: String?
    let email: String?
    let isCurrentUser: Bool
    let status: String?
}

struct EventOutput: Codable {
    let calendarExternalId: String
    let sourceEventId: String
    let icalUid: String?
    let recurrenceId: String
    let title: String
    let description: String?
    let startsAt: String
    let endsAt: String
    let isAllDay: Bool
    let status: String
    let meetingUrl: String?
    let location: String?
    let organizer: PartyOutput?
    let attendees: [PartyOutput]?
    let sourceUpdatedAt: String?
}

struct SnapshotOutput: Codable {
    let events: [EventOutput]
}

struct ChangeOutput: Codable {
    let type: String
}

enum HelperError: Error, LocalizedError {
    case invalidArguments(String)
    case permissionDenied
    case encode

    var errorDescription: String? {
        switch self {
        case let .invalidArguments(message): return message
        case .permissionDenied: return "Calendar permission is not granted"
        case .encode: return "Could not encode EventKit output"
        }
    }
}

private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private func limited(_ value: String?, to count: Int) -> String? {
    guard let value else { return nil }
    return String(value.prefix(count))
}

private func writeJson<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func authorizationStatus() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        switch status {
        case .fullAccess: return "granted"
        case .writeOnly: return "write-only"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unknown"
        }
    }
    switch status {
    case .fullAccess: return "granted"
    case .writeOnly: return "write-only"
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

private func requestAccess(_ store: EKEventStore) async throws {
    if #available(macOS 14.0, *) {
        _ = try await store.requestFullAccessToEvents()
    } else {
        _ = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Bool, Error>) in
            store.requestAccess(to: .event) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
    }
}

private func hexColor(_ calendar: EKCalendar) -> String? {
    guard let color = calendar.cgColor,
          let components = color.components,
          components.count >= 3 else { return nil }
    let red = Int((components[0] * 255).rounded())
    let green = Int((components[1] * 255).rounded())
    let blue = Int((components[2] * 255).rounded())
    return String(format: "#%02X%02X%02X", red, green, blue)
}

private func sourceType(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "icloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown"
    }
}

private func calendarOutput(
    _ calendar: EKCalendar,
    defaultCalendarIdentifier: String?
) -> CalendarOutput {
    CalendarOutput(
        externalId: calendar.calendarIdentifier,
        title: limited(calendar.title, to: 256) ?? "(untitled)",
        color: hexColor(calendar),
        sourceTitle: limited(calendar.source.title, to: 256),
        sourceType: sourceType(calendar.source.sourceType),
        allowsContentModifications: calendar.allowsContentModifications,
        primary: calendar.calendarIdentifier == defaultCalendarIdentifier
    )
}

private func participantStatus(_ status: EKParticipantStatus) -> String? {
    switch status {
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in-process"
    case .unknown: return nil
    @unknown default: return nil
    }
}

private func partyOutput(_ participant: EKParticipant) -> PartyOutput {
    let address = participant.url.absoluteString
    let email = address.lowercased().hasPrefix("mailto:")
        ? String(address.dropFirst("mailto:".count))
        : nil
    return PartyOutput(
        name: limited(participant.name, to: 256),
        email: limited(email, to: 320),
        isCurrentUser: participant.isCurrentUser,
        status: participantStatus(participant.participantStatus)
    )
}

private func recurrenceId(_ event: EKEvent) -> String {
    let recurring = event.hasRecurrenceRules || event.occurrenceDate != nil
    guard recurring else { return "single" }
    guard let occurrence = event.occurrenceDate ?? event.startDate else { return "single" }
    if event.isAllDay {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = event.timeZone ?? .current
        formatter.dateFormat = "yyyy-MM-dd"
        return "date:\(formatter.string(from: occurrence))"
    }
    return "time:\(Int64((occurrence.timeIntervalSince1970 * 1000).rounded()))"
}

private func eventOutput(_ event: EKEvent) -> EventOutput? {
    guard event.status != .canceled else { return nil }
    guard let startDate = event.startDate, let endDate = event.endDate else { return nil }
    let occurrenceIdentity = recurrenceId(event)
    // EventKit identifiers are device-local and can change after a full store
    // reset. Combining the calendar-item id with immutable occurrence identity
    // keeps recurring instances distinct inside one authoritative device feed.
    let sourceEventId = "\(event.calendarItemIdentifier):\(occurrenceIdentity)"
    return EventOutput(
        calendarExternalId: event.calendar.calendarIdentifier,
        sourceEventId: sourceEventId,
        icalUid: event.calendarItemExternalIdentifier,
        recurrenceId: occurrenceIdentity,
        title: limited(event.title, to: 512) ?? "(no title)",
        description: limited(event.notes, to: 20_000),
        startsAt: isoFormatter.string(from: startDate),
        endsAt: isoFormatter.string(from: endDate),
        isAllDay: event.isAllDay,
        status: event.status == .tentative ? "tentative" : "confirmed",
        meetingUrl: limited(event.url?.absoluteString, to: 2_048),
        location: limited(event.location, to: 1_024),
        organizer: event.organizer.map(partyOutput),
        attendees: event.attendees.map { Array($0.prefix(100)).map(partyOutput) },
        sourceUpdatedAt: event.lastModifiedDate.map(isoFormatter.string)
    )
}

private func value(after flag: String, in arguments: [String]) throws -> String {
    guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
        throw HelperError.invalidArguments("Missing \(flag)")
    }
    return arguments[index + 1]
}

private func listCalendars(_ store: EKEventStore) throws {
    guard authorizationStatus() == "granted" else { throw HelperError.permissionDenied }
    let defaultCalendarIdentifier = store.defaultCalendarForNewEvents?.calendarIdentifier
    try writeJson(
        store.calendars(for: .event).map {
            calendarOutput($0, defaultCalendarIdentifier: defaultCalendarIdentifier)
        }
    )
}

private func snapshot(_ store: EKEventStore, arguments: [String]) throws {
    guard authorizationStatus() == "granted" else { throw HelperError.permissionDenied }
    let startString = try value(after: "--start", in: arguments)
    let endString = try value(after: "--end", in: arguments)
    guard let start = isoFormatter.date(from: startString),
          let end = isoFormatter.date(from: endString),
          end > start else {
        throw HelperError.invalidArguments("Invalid snapshot window")
    }
    let requestedIds = Set(arguments.enumerated().compactMap { index, value in
        value == "--calendar" && arguments.indices.contains(index + 1)
            ? arguments[index + 1]
            : nil
    })
    let calendars = store.calendars(for: .event).filter {
        requestedIds.contains($0.calendarIdentifier)
    }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate).compactMap(eventOutput)
    try writeJson(SnapshotOutput(events: events))
}

private final class StoreWatcher {
    private let store: EKEventStore
    private var observer: NSObjectProtocol?

    init(store: EKEventStore) {
        self.store = store
    }

    func run() throws -> Never {
        guard authorizationStatus() == "granted" else { throw HelperError.permissionDenied }
        observer = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: store,
            queue: nil
        ) { _ in
            try? writeJson(ChangeOutput(type: "changed"))
        }
        RunLoop.current.run()
        fatalError("EventKit watcher run loop ended")
    }
}

@main
struct PrismicalEventKit {
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first else {
                throw HelperError.invalidArguments(
                    "Usage: prismical-eventkit <status|authorize|list-calendars|snapshot|watch>"
                )
            }
            let store = EKEventStore()
            switch command {
            case "status":
                try writeJson(PermissionOutput(authorizationStatus: authorizationStatus()))
            case "authorize":
                try await requestAccess(store)
                try writeJson(PermissionOutput(authorizationStatus: authorizationStatus()))
            case "list-calendars":
                try listCalendars(store)
            case "snapshot":
                try snapshot(store, arguments: arguments)
            case "watch":
                _ = try StoreWatcher(store: store).run()
            default:
                throw HelperError.invalidArguments("Unknown command: \(command)")
            }
        } catch {
            let message = "prismical-eventkit: \(error.localizedDescription)\n"
            FileHandle.standardError.write(message.data(using: .utf8)!)
            Foundation.exit(1)
        }
    }
}
