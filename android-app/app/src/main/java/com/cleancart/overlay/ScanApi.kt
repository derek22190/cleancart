package com.cleancart.overlay

import android.content.Context
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** Minimal HTTP client for POST /api/scan and /api/referral (no third-party dependencies). */
object ScanApi {
    private val ENDPOINTS = listOf(
        "https://www.heybroc.com/api/scan",
        "https://heybroc.com/api/scan",
        "https://cleancart-teal.vercel.app/api/scan",
    )
    private val REFERRAL_ENDPOINTS = listOf(
        "https://www.heybroc.com/api/referral",
        "https://heybroc.com/api/referral",
        "https://cleancart-teal.vercel.app/api/referral",
    )
    private val TRUSTED_HOSTS = setOf(
        "www.heybroc.com",
        "heybroc.com",
        "cleancart-teal.vercel.app",
    )

    private const val MAX_CACHE_SIZE = 150
    private val responseCache = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
            size > MAX_CACHE_SIZE
    }

    fun deviceId(ctx: Context): String {
        val prefs = ctx.getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val cached = prefs.getString("deviceId", null)
        if (!cached.isNullOrBlank()) return cached
        val androidId = runCatching {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull()?.takeIf { it.length >= 6 }
        val resolved = androidId ?: UUID.randomUUID().toString()
        prefs.edit().putString("deviceId", resolved).apply()
        return resolved
    }

    /** Generates the user's personal BROC-XXXXX invite code (matches lib/referrals.ts). */
    fun myReferralCode(ctx: Context): String {
        val clean = deviceId(ctx).replace(Regex("[^a-zA-Z0-9]"), "").uppercase()
        var hash = 2166136261.toInt()
        for (ch in clean) {
            hash = hash xor ch.code
            hash *= 16777619
        }
        val alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        var v = hash.toLong() and 0xFFFFFFFFL
        val suffix = StringBuilder()
        for (i in 0 until 5) {
            suffix.append(alphabet[(v % alphabet.length).toInt()])
            v /= alphabet.length
        }
        return "BROC-$suffix"
    }

    fun referredByCode(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        return prefs.getString("referredByCode", null)?.takeIf { it.isNotBlank() }
    }

    fun saveReferredByCode(ctx: Context, rawCode: String): String {
        val clean = rawCode.trim().uppercase()
            .substringAfterLast("/R/")
            .substringAfterLast("REF=")
            .replace(Regex("[^A-Z0-9-]"), "")
        val prefs = ctx.getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        prefs.edit().putString("referredByCode", clean).apply()
        return clean
    }

    /** Blocking call — claims a friend's invite code on /api/referral. */
    fun claimReferral(ctx: Context, rawCode: String): String {
        val clean = saveReferredByCode(ctx, rawCode)
        val body = JSONObject().apply {
            put("action", "claim")
            put("deviceId", deviceId(ctx))
            put("referredByCode", clean)
        }.toString()
        for (endpoint in REFERRAL_ENDPOINTS) {
            try {
                val res = postFollowingRedirects(endpoint, body, maxRedirects = 4)
                if (res.startsWith("{")) return res
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return """{"ok":true,"offlineSaved":true}"""
    }

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val prefs = ctx.getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
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

    private fun postFollowingRedirects(urlStr: String, jsonBody: String, maxRedirects: Int): String {
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
