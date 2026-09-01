/** Format timestamps using the host's local wall-clock timezone. */

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatLocalTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return [
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
	].join(" ");
}
