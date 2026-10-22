// AI Panel — eksport najbliższych wydarzeń z aplikacji Kalendarz (EventKit) do JSON.
//
//   calendar-helper <plik.json>          działa w tle, odświeża co minutę i po każdej zmianie
//   calendar-helper --once [plik.json]   jednorazowy zrzut (bez pliku → stdout)
//
// Uruchamiany przez launchd, żeby zgoda na dostęp do kalendarza była przypisana do tego programu.
import EventKit
import Foundation

let store = EKEventStore()
var args = Array(CommandLine.arguments.dropFirst())
let once = args.first == "--once"
if once { args.removeFirst() }
let outPath = args.first

let lookAhead: TimeInterval = 48 * 3600
let meetingLink = try! NSRegularExpression(
    pattern: #"https://[^\s<>"]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)[^\s<>"]*"#)

func ms(_ d: Date) -> Int64 { Int64(d.timeIntervalSince1970 * 1000) }

func hex(_ c: CGColor?) -> String? {
    guard let c = c?.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
          let p = c.components, p.count >= 3 else { return nil }
    return String(format: "#%02X%02X%02X", Int(p[0] * 255), Int(p[1] * 255), Int(p[2] * 255))
}

func link(_ e: EKEvent) -> String? {
    if let u = e.url?.absoluteString, u.hasPrefix("https://") { return u }
    for text in [e.location, e.notes].compactMap({ $0 }) {
        let range = NSRange(text.startIndex..., in: text)
        if let m = meetingLink.firstMatch(in: text, range: range), let r = Range(m.range, in: text) {
            return String(text[r])
        }
    }
    return nil
}

func declined(_ e: EKEvent) -> Bool {
    e.attendees?.first(where: { $0.isCurrentUser })?.participantStatus == .declined
}

func write(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    if let p = outPath {
        let url = URL(fileURLWithPath: p)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    } else {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func dump() {
    let now = Date()
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
        write(["events": [], "error": "no_access", "updatedAt": ms(now)])
        return
    }
    let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-12 * 3600),
                                        end: now.addingTimeInterval(lookAhead), calendars: nil)
    let events = store.events(matching: pred)
        .filter { $0.endDate > now && $0.status != .canceled && !declined($0) }
        .sorted { $0.startDate < $1.startDate }
        .prefix(30)
        .map { e -> [String: Any] in
            var o: [String: Any] = [
                "title": e.title ?? "(bez tytułu)",
                "start": ms(e.startDate),
                "end": ms(e.endDate),
                "allDay": e.isAllDay,
                "calendar": e.calendar.title,
            ]
            if let c = hex(e.calendar.cgColor) { o["color"] = c }
            if let l = e.location, !l.isEmpty { o["location"] = l }
            if let u = link(e) { o["link"] = u }
            return o
        }
    write(["events": Array(events), "updatedAt": ms(now)])
}

store.requestFullAccessToEvents { _, _ in
    DispatchQueue.main.async {
        dump()
        if once { exit(0) }
    }
}

if !once {
    NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in
        store.refreshSourcesIfNecessary()
        dump()
    }
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in dump() }
}
RunLoop.main.run()
