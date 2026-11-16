interface Env {
	UNO: Fetcher;
}

interface PagesContext {
	request: Request;
	env: Env;
	next: () => Promise<Response>;
}

export async function onRequest(context: PagesContext): Promise<Response> {
	const { pathname } = new URL(context.request.url);
	if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
		return context.env.UNO.fetch(context.request);
	}
	return context.next();
}
