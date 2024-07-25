import { Computed, Context, Schema, h } from "koishi"
import { resolve as urlResolve } from "url"

export const name = "mediawiki-links"
export const inject = ["http"]

export interface Config {
  wikis: {
    prefix: string[]
    endpoint: string
  }[]
  defaultWikis: Computed<string[]>
}

export const Config: Schema<Config> = Schema.object({
  wikis: Schema.array(
    Schema.object({
      prefix: Schema.array(String)
        .role("table")
        .required()
        .description("维基名称（同时用作跨 wiki 前缀）。"),
      endpoint: Schema.string()
        .required()
        .description("维基的 `api.php` URL。")
        .role("textarea"),
    })
  )
    .required()
    .description("维基列表。")
    .default([
      {
        prefix: ["萌百", "mgp"],
        endpoint: "https://zh.moegirl.org.cn/api.php",
      },
    ]),
  defaultWikis: Schema.computed(
    Schema.array(String).required().role("table")
  ).description("无 wiki 前缀时默认尝试查询哪些 wiki。"),
})

interface WikiConfig {
  readonly endpoint: string
  readonly siteName: string
  readonly baseURL: string
  readonly articlePath: string
}

class Wiki {
  static get [Symbol.toStringTag]() {
    return "mediawiki-links Wiki constructor"
  }
  get [Symbol.toStringTag]() {
    return "mediawiki-links Wiki"
  }

  protected constructor(
    protected readonly ctx: Context,
    public readonly config: WikiConfig
  ) {}

  static async fromEndpoint(ctx: Context, endpoint: string) {
    const siteInfo = await ctx.http.get(
      endpoint + "?format=json&formatversion=2&action=query&meta=siteinfo&siprop=general",
      { responseType: "json" }
    )
    const siteName = siteInfo.query.general.sitename
    const baseURL = siteInfo.query.general.base
    const articlePath = siteInfo.query.general.articlepath
    return new this(ctx, {
      endpoint,
      siteName,
      baseURL,
      articlePath,
    })
  }

  async resolveTitles(titles: string[]) {
    const titlesStr = encodeURIComponent(titles.join("|"))
    const info = await this.ctx.http.get(
      `${this.config.endpoint}?format=json&formatversion=2&action=query&titles=${titlesStr}&redirects=1`,
      { responseType: "json" }
    )
    const result: Wiki.ResolveTitlesResult = Object.create(null)
    for (let rawTitle of titles) {
      const normalized = info.query.normalized?.find(item => item.from === rawTitle)
      const title = normalized ? normalized.to : rawTitle
      const redirect = info.query.redirects?.find(item => item.from === title)
      if (!redirect && info.query.pages?.find(item => item.title === title)?.missing)
        continue
      const page: (typeof result)[string] = {
        title,
        url: urlResolve(
          this.config.baseURL,
          this.config.articlePath.replace("$1", encodeURI(title).replaceAll("%20", "_"))
        ),
      }
      if (redirect) {
        let redirectsTo = redirect.to
        if (redirect.tofragment) redirectsTo += "#" + redirect.tofragment
        page.redirectsTo = redirectsTo
      }
      result[rawTitle] = page
    }
    return result
  }
}

namespace Wiki {
  export type ResolveTitlesResult = Record<
    string,
    {
      title: string
      redirectsTo?: string
      url: string
    }
  >
}

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)
  logger.level = 3

  const wikiDict: Record<string, Wiki | null> = Object.create(null)
  ctx.on("ready", () => {
    for (const { prefix, endpoint } of config.wikis) {
      Wiki.fromEndpoint(ctx, endpoint).then(
        wiki => {
          for (const i of prefix) wikiDict[i] = wiki
        },
        exc => {
          if (exc?.message === "context disposed") return
          logger.error("error init wiki", { endpoint })
          logger.error(exc)
          for (const i of prefix) wikiDict[i] = null
        }
      )
    }
  })

  ctx.middleware(async (session, next) => {
    var titles = new Set<string>()
    for (const el of h.select(session.elements, "text")) {
      for (const [, title] of (el.attrs.content as string).matchAll(
        /\[\[\s*([^\x00-\x1f<>[\]|{}\x7f]+)\s*(?:\|.*?)?\]\]/g
      ))
        titles.add(title)
    }
    if (!titles.size) return next()
    logger.debug("content", session.content)
    logger.debug("titles", titles)

    let defaultWikis: Wiki[]

    const taskMap = new Map<Wiki, string[]>()
    const queries = [...titles].map(title => {
      const titleParts = title.split(":")
      let wikis: Wiki[]
      for (let i = titleParts.length - 1; i > 0; i--) {
        const prefix = titleParts
          .slice(0, i)
          .map(s => s.trim())
          .join(":")
        if (prefix in wikiDict) {
          wikis = [wikiDict[prefix]]
          title = titleParts.slice(i).join(":")
          break
        }
      }

      if (!wikis) {
        wikis = defaultWikis ??= session.resolve(config.defaultWikis).flatMap(i => {
          const wiki = wikiDict[i]
          if (!wiki) {
            if (!(i in wikiDict)) logger.error("wiki not defined:", i)
            return []
          }
          return [wiki]
        })
      }
      for (const wiki of wikis) {
        if (taskMap.has(wiki)) taskMap.get(wiki).push(title)
        else taskMap.set(wiki, [title])
      }

      return { title, wikis }
    })
    logger.debug("taskMap", taskMap)
    if (!taskMap.size) return next()

    const taskResultMap = new Map<Wiki, Wiki.ResolveTitlesResult>()
    await Promise.all(
      Array.from(taskMap, async ([wiki, titles]) => {
        try {
          taskResultMap.set(wiki, await wiki.resolveTitles(titles))
        } catch (exc) {
          logger.error("error resolving titles", { wiki, titles })
          logger.error(exc)
        }
      })
    )
    logger.debug("taskResultMap", taskResultMap)

    const results: string[] = []
    for (const { title, wikis } of queries) {
      for (const wiki of wikis) {
        if (!taskResultMap.has(wiki)) continue
        const result = taskResultMap.get(wiki)[title]
        if (!result) continue
        results.push(
          session.text(
            result.redirectsTo
              ? "mediawiki-links.result-redirected"
              : "mediawiki-links.result",
            {
              ...result,
              siteName: wiki.config.siteName,
            }
          )
        )
      }
    }
    if (results.length) return results.join("\n")

    return next()
  })

  ctx.i18n.define("zh", "mediawiki-links", {
    "result": "<i>{siteName}</i> — <b>{title}</b>: {url}",
    "result-redirected":
      "<i>{siteName}</i> — <b>{title}</b> (→ <b>{redirectsTo}</b>): {url}",
  })
}
