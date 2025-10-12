import { Argv, Computed, Context, Schema, Session, h } from "koishi"
import { resolve as urlResolve } from "url"

import type {} from "@dgck81lnn/koishi-plugin-auto-delete-response"

export const name = "mediawiki-links"
export const inject = {
  required: ["http"],
  optional: ["autoDeleteResponse"],
}

export interface Config {
  wikis: {
    disabled: boolean
    prefix: string[]
    endpoint: string
  }[]
  defaultWikis: Computed<string[]>
}

export const Config: Schema<Config> = Schema.object({
  wikis: Schema.array(
    Schema.object({
      disabled: Schema.boolean().default(false).description("禁用该 wiki"),
      prefix: Schema.array(String)
        .role("table")
        .min(1)
        .description("wiki 名称（同时用作跨 wiki 前缀）。不同 wiki 间不可重复。"),
      endpoint: Schema.string()
        .description(
          "维基的 api.php URL。通常位于网站的 `/api.php` 或 `/w/api.php`。可到 wiki 的 Special:Version 页面查询。"
        )
        .role("textarea"),
    })
  )
    .description("可解析的 wiki 列表。")
    .min(1)
    .default([
      {
        disabled: false,
        hidden: false,
        prefix: ["萌百", "mgp"],
        endpoint: "https://zh.moegirl.org.cn/api.php",
      },
    ]),
  defaultWikis: Schema.computed(Schema.array(String).role("table")).description(
    "未指定 wiki 前缀时默认尝试查询哪些 wiki。"
  ),
})

interface WikiConfig {
  readonly endpoint: string
  readonly siteName: string
  readonly baseURL: string
  readonly articlePath: string
}

class Wiki {
  protected constructor(
    protected readonly ctx: Context,
    public readonly config: WikiConfig
  ) {}

  static async fromEndpoint(ctx: Context, endpoint: string) {
    const siteInfo = await ctx.http.get(endpoint, {
      params: {
        format: "json",
        formatversion: "2",
        action: "query",
        meta: "siteinfo",
        siprop: "general",
      },
      responseType: "json",
    })
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
    const titlesStr = titles.join("|")
    const params = {
      format: "json",
      formatversion: "2",
      action: "query",
      titles: titlesStr,
      redirects: "1",
    }
    this.ctx.logger.debug("request to %s on %o", this.config.endpoint, titles)
    const info = await this.ctx.http.get(this.config.endpoint, {
      params,
      responseType: "json",
    })
    this.ctx.logger.debug(
      "response from %s on %o: %o",
      this.config.endpoint,
      titles,
      info
    )
    const result: Wiki.ResolveTitlesResult = Object.create(null)
    for (let rawTitle of titles) {
      const normalized = info.query.normalized?.find(item => item.from === rawTitle)
      const title = normalized ? normalized.to : rawTitle
      if (info.query.interwiki?.some(item => item.title === title)) continue
      const redirect = info.query.redirects?.find(item => item.from === title)
      if (!redirect) {
        const page = info.query.pages?.find(item => item.title === title)
        if (page?.missing || page?.invalid) continue
      }
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
  const wikiDict: Record<string, Wiki | null> = Object.create(null)
  ctx.on("ready", () => {
    for (const { disabled, prefix, endpoint } of config.wikis) {
      for (const i of prefix) {
        if (i in wikiDict) ctx.logger.warn("duplicate wiki prefix:", i)
        wikiDict[i] = null
      }

      if (disabled) continue

      const fun = (isRetry = false) =>
        Wiki.fromEndpoint(ctx, endpoint).then(
          wiki => {
            if (isRetry) ctx.logger.info("retry success, init wiki", endpoint)
            else ctx.logger.debug("success init wiki", endpoint)
            for (const i of prefix) wikiDict[i] = wiki
          },
          exc => {
            if (exc?.message === "context disposed") return
            ctx.logger[isRetry ? "debug" : "error"]("error init wiki", endpoint)
            ctx.logger[isRetry ? "debug" : "error"](exc)
            ctx.setTimeout(() => fun(true), 60000)
          }
        )
      fun()
    }
  })

  function getDefaultWikis(session: Session) {
    const d = session.resolve(config.defaultWikis)
    if (!d) return []
    return d.flatMap(i => {
      if (!wikiDict[i]) {
        if (!(i in wikiDict)) ctx.logger.error("wiki not defined:", i)
        return []
      }
      return [wikiDict[i]]
    })
  }

  async function resolve(titles: Iterable<string>, session: Session) {
    const taskMap = new Map<Wiki, string[]>()
    const queries = [...titles].map(title => {
      const titleWithoutHash = title.split("#")[0].trim()
      const hash = title.slice(titleWithoutHash.length + 1)
      const titleParts = titleWithoutHash.split(":")
      let wikis: Wiki[]
      let titleStripped = titleWithoutHash
      for (let i = titleParts.length - 1; i > 0; i--) {
        const prefix = titleParts
          .slice(0, i)
          .map(s => s.trim())
          .join(":")
        if (prefix in wikiDict) {
          wikis = [wikiDict[prefix]]
          titleStripped = titleParts.slice(i).join(":")
          break
        }
      }
      wikis ??= getDefaultWikis(session)

      for (const wiki of wikis) {
        if (taskMap.has(wiki)) taskMap.get(wiki).push(titleStripped)
        else taskMap.set(wiki, [titleStripped])
      }

      return { title, titleStripped, hash, wikis }
    })
    ctx.logger.debug("taskMap", taskMap)
    if (!taskMap.size) return

    const taskResultMap = new Map<Wiki, Promise<Wiki.ResolveTitlesResult>>()
    for (const [wiki, titles] of taskMap) {
      try {
        taskResultMap.set(
          wiki,
          wiki.resolveTitles(titles).catch(() => null)
        )
      } catch (exc) {
        ctx.logger.error("error resolving titles", { wiki, titles })
        ctx.logger.error(exc)
      }
    }

    const results: Record<
      string,
      {
        wiki: Wiki
        title: string
        redirectsTo?: string
        url: string
      }
    > = Object.create(null)
    await Promise.all(
      queries.map(async ({ title, titleStripped, hash, wikis }) => {
        for (const wiki of wikis) {
          if (!taskResultMap.has(wiki)) continue
          ctx.logger.debug(
            "await request to %s on %o",
            wiki.config.endpoint,
            titleStripped
          )
          const result = (await taskResultMap.get(wiki))?.[titleStripped]
          if (result)
            ctx.logger.debug(
              "got result from %s on %o: %o",
              wiki.config.endpoint,
              titleStripped,
              result
            )
          if (!result) continue
          let displayTitle = result.title
          let url = result.url
          if (hash) {
            displayTitle += "#" + hash
            url = Object.assign(new URL(url), { hash }).toString()
          }
          results[title] = { wiki, ...result, title: displayTitle, url }
          break
        }
      })
    )
    return results
  }

  ctx.middleware(async (session, next) => {
    var titles = new Set<string>()
    for (const el of h.select(session.elements, "text")) {
      for (const [, title] of (el.attrs.content as string).matchAll(
        /\[\[\s*([^\x00-\x1f<>[\]|{}\x7f]+)\s*(?:\|.*?)?\]\]/g
      ))
        titles.add(title)
    }
    if (!titles.size) return next()
    ctx.logger.debug("content", session.content)
    ctx.logger.debug("titles", titles)

    const results = await resolve(titles, session)
    if (!results) return next()

    const lines = Object.values(results)
      .filter(Boolean)
      .map(result =>
        session.i18n(
          result.redirectsTo
            ? "mediawiki-links.result-redirected"
            : "mediawiki-links.result",
          {
            ...result,
            siteName: result.wiki.config.siteName,
          }
        )
      )
    if (lines.length) {
      const response = lines.map(line => h("p", line))
      if (ctx.autoDeleteResponse) {
        await ctx.autoDeleteResponse.send(session, response)
        return []
      }
      return response
    }

    return next()
  })

  async function doResolveSingle({ session }: Argv, title: string) {
    if (!title) {
      const lines = config.wikis
        .filter(({ disabled }) => !disabled)
        .map(({ prefix }) => {
          const siteName =
            wikiDict[prefix[0]]?.config.siteName ?? session.i18n(".not-connected")
          return [`${prefix.join(", ")}: `, siteName].flat()
        })
      lines.push(
        session.i18n(".default-wikis", [
          session.resolve(config.defaultWikis)?.join(", ") || session.i18n(".none"),
        ])
      )
      return lines.map(l => h("p", l))
    }
    const results = await resolve([title], session)
    if (!results) return session.i18n(".require-prefix")
    if (results[title]) return [h.text(results[title].url)]
    return session.i18n(".not-found", { title })
  }

  ctx
    .command("wiki [title:text]", { showWarning: true, checkUnknown: true })
    .action((argv, title) => {
      if (ctx.autoDeleteResponse)
        return ctx.autoDeleteResponse.action(doResolveSingle)(argv, title)
      return doResolveSingle(argv, title)
    })

  ctx.i18n.define("zh-CN", "mediawiki-links", {
    "result": "<i>{siteName}</i> — <b>{title}</b>: {url}",
    "result-redirected":
      "<i>{siteName}</i> — <b>{title}</b> (→ <b>{redirectsTo}</b>): {url}",
  })
  ctx.i18n.define("zh-CN", "commands.wiki", {
    description: "获取 wiki 条目的链接",
    usage:
      "输入格式：wiki 前缀与一个 wiki 页面的标题，用半角冒号分隔；存在默认 wiki 时，默认 wiki 的前缀可省略。<br/>" +
      "输入为空时，显示所有可用 wiki 及对应前缀列表。",
    messages: {
      "require-prefix": "当前无默认 wiki，请指定 wiki 前缀。",
      "not-found": "未找到名为 {title} 的条目。",
      "not-connected": "[连接中…]",
      "default-wikis": "当前默认 wiki：{0}",
      "none": "(无)",
    },
  })
}
