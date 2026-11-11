import type { Request } from 'express';

function proxyMatcher(value: unknown): value is (address: string, hop: number) => boolean {
	return typeof value === 'function';
}

/** One canonical authority only; reject userinfo, lists, paths and ambiguous host syntax. */
export function normalizedAuthority(value: unknown): string | null {
	if (
		typeof value !== 'string' ||
		value.length > 260 ||
		!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[0-9]{1,5})?$/iu.test(value)
	)
		return null;
	try {
		const url = new URL(`https://${value.toLowerCase()}`);
		if (url.hostname.endsWith('.') || url.hostname.includes('..')) return null;
		return url.host;
	} catch {
		return null;
	}
}

export function requestAuthority(request: Request): string | null {
	const trust: unknown = request.app.get('trust proxy fn');
	if (
		request.socket.remoteAddress !== undefined &&
		proxyMatcher(trust) &&
		trust(request.socket.remoteAddress, 0) &&
		request.headers['x-forwarded-host'] !== undefined
	)
		return normalizedAuthority(request.headers['x-forwarded-host']);
	return normalizedAuthority(request.headers.host);
}

/** Permit ephemeral loopback test listeners only when the configured API itself is local. */
export function localRequestAuthority(request: Request, authority: string, api: URL): boolean {
	const localHosts = ['localhost', '127.0.0.1', '[::1]'];
	const target = new URL(`https://${authority}`);
	return (
		localHosts.includes(api.hostname) &&
		localHosts.includes(target.hostname) &&
		target.port === String(request.socket.localPort)
	);
}
