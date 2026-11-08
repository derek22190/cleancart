package com.cleancart.overlay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/** Minimal HTTP client for POST /api/scan and /api/referral (no third-party dependencies). */
object ScanApi {
    private val customBase = BuildConfig.API_BASE.trim().trimEnd('/')
    private val ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/scan" },
        "https://www.heybroc.com/api/scan",
        "https://heybroc.com/api/scan",
        "https://cleancart-teal.vercel.app/api/scan",
    ).distinct()
    private val REFERRAL_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/referral" },
        "https://www.heybroc.com/api/referral",
        "https://heybroc.com/api/referral",
        "https://cleancart-teal.vercel.app/api/referral",
    ).distinct()
    private val SUGGEST_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/suggest" },
        "https://www.heybroc.com/api/suggest",
        "https://heybroc.com/api/suggest",
        "https://cleancart-teal.vercel.app/api/suggest",
    ).distinct()
    private val TRUSTED_HOSTS = setOfNotNull(
        runCatching { URL(customBase).host.lowercase() }.getOrNull()?.takeIf { it.isNotBlank() },
        "www.heybroc.com",
        "heybroc.com",
        "cleancart-teal.vercel.app",
    )

    private const val PREFS_NAME = "ingredient_preferences"
    private const val KEY_INSTALL_UUID = "install_uuid_v2"
    private const val KEY_DEVICE_SECRET = "device_secret_v1"
    private const val KEY_SERVER_REF_CODE = "server_referral_code"
    private const val KEY_PRO_ACTIVE = "entitlement_pro_active"
    private const val KEY_PRO_UNTIL = "entitlement_pro_until"
    private const val KEY_SWAPS_REMAINING = "entitlement_swaps_remaining"
    private const val KEY_SWAPS_LIMIT = "entitlement_swaps_limit"
    private const val KEY_PAYWALL_HEADLINE = "entitlement_paywall_headline"
    private const val KEY_PAYWALL_VARIANT = "entitlement_paywall_variant"
    private const val DEFAULT_FREE_WEEKLY_SWAPS = 5

    /** Blocking call — returns up to 8 live product suggestions from GET /api/suggest?q=<query>. */
    fun suggest(rawQuery: String): List<JSONObject> {
        val q = rawQuery.trim()
        if (q.isEmpty()) return emptyList()
        val encoded = URLEncoder.encode(q, "UTF-8")
        for (base in SUGGEST_ENDPOINTS) {
            try {
                val url = URL("$base?q=$encoded")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 2500
                    readTimeout = 3500
                    setRequestProperty("Accept", "application/json")
                }
                try {
                    if (conn.responseCode in 200..299) {
                        val body = conn.inputStream.bufferedReader().use(BufferedReader::readText)
                        val arr = JSONObject(body).optJSONArray("suggestions") ?: continue
                        val out = ArrayList<JSONObject>(arr.length())
                        for (i in 0 until arr.length()) {
                            arr.optJSONObject(i)?.let { out.add(it) }
                        }
                        if (out.isNotEmpty()) return out
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return emptyList()
    }

    private const val MAX_CACHE_SIZE = 150
    private val responseCache = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
            size > MAX_CACHE_SIZE
    }

    /**
     * Install-scoped random UUID (never reads hardware Settings.Secure.ANDROID_ID).
     */
    fun deviceId(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(KEY_INSTALL_UUID, null)
        if (!cached.isNullOrBlank()) return cached
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALL_UUID, generated).apply()
        return generated
    }

    fun deviceSecret(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(KEY_DEVICE_SECRET, null)
        if (!cached.isNullOrBlank()) return cached
        val generated = UUID.randomUUID().toString() + "-" + UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_SECRET, generated).apply()
        return generated
    }

    /** Persists server-authoritative entitlement fields returned by /api/scan or /api/referral. */
    fun saveEntitlementSnapshot(ctx: Context, ent: JSONObject?) {
        if (ent == null) return
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val edit = prefs.edit()
        if (ent.has("isProActive")) {
            edit.putBoolean(KEY_PRO_ACTIVE, ent.optBoolean("isProActive", false))
        }
        if (ent.has("proUntil")) {
            edit.putLong(KEY_PRO_UNTIL, ent.optLong("proUntil", 0L))
        }
        if (ent.has("swapsRemaining")) {
            edit.putInt(KEY_SWAPS_REMAINING, ent.optInt("swapsRemaining", DEFAULT_FREE_WEEKLY_SWAPS))
        }
        if (ent.has("weeklySwapsLimit")) {
            edit.putInt(KEY_SWAPS_LIMIT, ent.optInt("weeklySwapsLimit", DEFAULT_FREE_WEEKLY_SWAPS))
        }
        val pwHeadline = ent.optString("paywallHeadline").trim()
        if (pwHeadline.isNotBlank() && pwHeadline != "null") {
            edit.putString(KEY_PAYWALL_HEADLINE, pwHeadline)
        }
        val pwVariant = ent.optString("paywallVariant").trim()
        if (pwVariant == "A" || pwVariant == "B") {
            edit.putString(KEY_PAYWALL_VARIANT, pwVariant)
        }
        val refCode = ent.optString("referralCode").trim()
        if (refCode.startsWith("BROC-")) {
            edit.putString(KEY_SERVER_REF_CODE, refCode)
        }
        edit.apply()
    }

    fun paywallHeadline(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_PAYWALL_HEADLINE, null)
            ?.takeIf { it.isNotBlank() }
            ?: "Unlock Unlimited Clean Swaps"
    }

    fun weeklySwapsLimit(ctx: Context): Int {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_SWAPS_LIMIT, DEFAULT_FREE_WEEKLY_SWAPS).coerceAtLeast(1)
    }

    /** Non-blocking first-party funnel event ping to /api/analytics (forwarded server-side to PostHog). */
    fun trackEvent(ctx: Context, eventName: String, properties: JSONObject? = null) {
        val appCtx = ctx.applicationContext
        Thread {
            runCatching {
                val prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val variant = prefs.getString(KEY_PAYWALL_VARIANT, "A") ?: "A"
                val body = JSONObject().apply {
                    put("action", "track")
                    put("event", eventName)
                    put("deviceId", deviceId(appCtx))
                    put("platform", "android")
                    put("variant", variant)
                    if (properties != null) {
                        put("properties", properties)
                    }
                }.toString()
                postFollowingRedirects("https://www.heybroc.com/api/analytics", body, maxRedirects = 2)
            }
        }.start()
    }

    fun isProActive(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val proFlag = prefs.getBoolean(KEY_PRO_ACTIVE, false)
        val proUntil = prefs.getLong(KEY_PRO_UNTIL, 0L)
        return if (proUntil > 0L) proUntil > System.currentTimeMillis() else proFlag
    }

    fun swapsRemaining(ctx: Context): Int {
        if (isProActive(ctx)) return Int.MAX_VALUE
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_SWAPS_REMAINING, DEFAULT_FREE_WEEKLY_SWAPS).coerceAtLeast(0)
    }

    fun canUseSwap(ctx: Context): Boolean {
        return isProActive(ctx) || swapsRemaining(ctx) > 0
    }

    /** Decrements local swap counter when on free tier and records the swap asynchronously on the server. */
    fun consumeSwap(ctx: Context, productTitle: String) {
        val appCtx = ctx.applicationContext
        if (!isProActive(appCtx)) {
            val prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val current = prefs.getInt(KEY_SWAPS_REMAINING, DEFAULT_FREE_WEEKLY_SWAPS)
            prefs.edit().putInt(KEY_SWAPS_REMAINING, (current - 1).coerceAtLeast(0)).apply()
        }
        Thread {
            runCatching {
                val body = JSONObject().apply {
                    put("action", "record_swap")
                    put("deviceId", deviceId(appCtx))
                    put("deviceSecret", deviceSecret(appCtx))
                    put("productKey", productTitle.trim().take(120))
                }.toString()
                for (endpoint in REFERRAL_ENDPOINTS) {
                    try {
                        val res = postFollowingRedirects(
                            endpoint,
                            body,
                            maxRedirects = 4,
                            extraHeaders = mapOf("X-Device-Secret" to deviceSecret(appCtx))
                        )
                        if (res.startsWith("{")) {
                            val json = JSONObject(res)
                            saveEntitlementSnapshot(appCtx, json.optJSONObject("entitlement"))
                            break
                        }
                    } catch (_: Exception) {
                        // try next endpoint
                    }
                }
            }
        }.start()
    }

    fun upgradeUrl(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val id = URLEncoder.encode(deviceId(ctx), "UTF-8")
        val ref = referredByCode(ctx)?.let { "&code=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
        val email = prefs.getString("auth_email", null)?.trim()?.takeIf { it.isNotBlank() }
            ?.let { "&email=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
        return "https://heybroc.com/?upgrade=1&deviceId=$id$ref$email"
    }

    /** Returns the server-issued BROC-XXXXXXXX invite code if available. */
    fun myReferralCode(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val serverCode = prefs.getString(KEY_SERVER_REF_CODE, null)
        if (!serverCode.isNullOrBlank()) return serverCode
        val clean = deviceId(ctx).replace(Regex("[^a-zA-Z0-9]"), "").uppercase()
        var hash = 2166136261.toInt()
        for (ch in clean) {
            hash = hash xor ch.code
            hash *= 16777619
        }
        val alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        var v = hash.toLong() and 0xFFFFFFFFL
        val suffix = StringBuilder()
        for (i in 0 until 8) {
            suffix.append(alphabet[((v xor (i * 31L)) and 0x7FFFFFFFL).toInt() % alphabet.length])
            v = (v shr 4) xor (v * 33L)
        }
        return "BROC-$suffix"
    }

    fun referredByCode(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("referredByCode", null)?.takeIf { it.isNotBlank() }
    }

    fun saveReferredByCode(ctx: Context, rawCode: String): String {
        val clean = rawCode.trim().uppercase()
            .substringAfterLast("/R/")
            .substringAfterLast("REF=")
            .replace(Regex("[^A-Z0-9-]"), "")
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("referredByCode", clean).apply()
        return clean
    }

    /** Blocking call — claims a friend's invite code on /api/referral. */
    fun claimReferral(ctx: Context, rawCode: String): String {
        val clean = saveReferredByCode(ctx, rawCode)
        val secret = deviceSecret(ctx)
        val body = JSONObject().apply {
            put("action", "claim")
            put("deviceId", deviceId(ctx))
            put("deviceSecret", secret)
            put("referralCode", clean)
            put("referredByCode", clean)
        }.toString()
        for (endpoint in REFERRAL_ENDPOINTS) {
            try {
                val res = postFollowingRedirects(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = mapOf("X-Device-Secret" to secret)
                )
                if (res.startsWith("{")) {
                    runCatching {
                        saveEntitlementSnapshot(ctx, JSONObject(res).optJSONObject("entitlement"))
                    }
                    return res
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return """{"ok":true,"offlineSaved":true}"""
    }

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .toSet()
        val refCode = referredByCode(ctx)
        val body = JSONObject().apply {
            put("productTitle", productTitle)
            if (!rawIngredients.isNullOrBlank()) put("rawIngredients", rawIngredients)
            put("store", store)
            if (familyWatchlist.isNotEmpty()) {
                put("familyWatchlist", JSONArray(familyWatchlist.toList().sorted()))
            }
            put("deviceId", deviceId(ctx))
            if (!refCode.isNullOrBlank()) {
                put("referredByCode", refCode)
            }
            put("format", "json")
        }.toString()

        synchronized(responseCache) {
            responseCache[body]?.let { return it }
        }

        var lastErr = """{"ok":false,"error":"Unable to reach HeyBroc server"}"""
        for (endpoint in ENDPOINTS) {
            try {
                val res = postFollowingRedirects(endpoint, body, maxRedirects = 4)
                if (res.startsWith("{") && (res.contains("\"ok\":true") || res.contains("\"ok\":false") || res.contains("\"result\""))) {
                    if (res.contains("\"ok\":true")) {
                        runCatching {
                            saveEntitlementSnapshot(ctx, JSONObject(res).optJSONObject("entitlement"))
                        }
                        synchronized(responseCache) {
                            responseCache[body] = res
                        }
                    }
                    return res
                }
                lastErr = res
            } catch (e: Exception) {
                lastErr = JSONObject().put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message ?: "network error"}").toString()
            }
        }
        return lastErr
    }

    private fun postFollowingRedirects(
        urlStr: String,
        jsonBody: String,
        maxRedirects: Int,
        extraHeaders: Map<String, String> = emptyMap()
    ): String {
        var currentUrl = urlStr
        var remaining = maxRedirects
        while (true) {
            val parsed = URL(currentUrl)
            require(parsed.protocol.equals("https", ignoreCase = true) && parsed.host.lowercase() in TRUSTED_HOSTS) {
                "Untrusted scan endpoint host: ${parsed.host}"
            }
            val conn = (parsed.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 8000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                for ((k, v) in extraHeaders) {
                    setRequestProperty(k, v)
                }
            }
            try {
                conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code in listOf(301, 302, 303, 307, 308) && remaining > 0) {
                    val loc = conn.getHeaderField("Location")
                    if (!loc.isNullOrBlank()) {
                        val nextUrl = URL(parsed, loc)
                        require(nextUrl.protocol.equals("https", ignoreCase = true) && nextUrl.host.lowercase() in TRUSTED_HOSTS) {
                            "Refusing redirect to untrusted host: ${nextUrl.host}"
                        }
                        currentUrl = nextUrl.toString()
                        remaining--
                        continue
                    }
                }
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText)?.trim().orEmpty()
                if (text.isNotEmpty()) return text
                return """{"ok":false,"error":"HTTP $code from $currentUrl"}"""
            } finally {
                conn.disconnect()
            }
        }
    }

    fun storeForPackage(pkg: String): String = when (pkg) {
        "com.walmart.android" -> "walmart"
        "com.instacart.client" -> "instacart"
        "com.target.ui" -> "target"
        "com.kroger.mobile" -> "kroger"
        "de.apptiv.business.android.aldi_us" -> "aldi"
        "com.dd.doordash" -> "doordash"
        "com.ubercab.eats" -> "ubereats"
        "com.amazon.mShop.android.shopping", "com.wholefoods.wholefoodsmarket" -> "amazon"
        "com.rfi.sams.android", "com.samsclub.app" -> "sams"
        "com.brandingbrand.reactnative.and.bjs", "com.bjs.mobile" -> "bjs"
        "com.costco.app.android" -> "costco"
        "com.shipt.groceries" -> "shipt"
        else -> "walmart"
    }

    /** Offline sample used by "Launch Test Overlay Pill" if the API isn't reachable. */
    const val SAMPLE_JSON = """
    {"ok":true,"product":{"title":"Berry Swirl Strawberry Lowfat Yogurt"},
     "result":{"score":35,"rating":"Poor","color":"red","flagged":[
       {"id":"red40","name":"Red 40","risk":"high","penalty":35,"explanation":"A petroleum-derived dye linked to hyperactivity in sensitive children and requiring a warning label in the EU."},
       {"id":"hfcs","name":"High Fructose Corn Syrup","risk":"moderate","penalty":20,"explanation":"A highly refined industrial sweetener tied to fatty-liver and metabolic issues when consumed regularly."},
       {"id":"ksorbate","name":"Potassium Sorbate","risk":"low","penalty":10,"explanation":"A common mold inhibitor that is generally low risk but signals a highly shelf-stabilized product."}]},
     "swap":{"title":"Stonyfield Organic Whole Milk Plain Yogurt","score":100,
       "webUrl":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt",
       "deepLink":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt",
       "androidPackage":"com.walmart.android"}}
    """
}
