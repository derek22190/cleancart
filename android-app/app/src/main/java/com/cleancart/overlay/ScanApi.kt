package com.cleancart.overlay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** Minimal HTTP client for POST /api/scan (no third-party dependencies). */
object ScanApi {
    private val ENDPOINTS = listOf(
        "https://www.heybroc.com/api/scan",
        "https://heybroc.com/api/scan",
        "https://cleancart-teal.vercel.app/api/scan",
    )
    private val TRUSTED_HOSTS = setOf(
        "www.heybroc.com",
        "heybroc.com",
        "cleancart-teal.vercel.app",
    )

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val prefs = ctx.getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
        val body = JSONObject().apply {
            put("productTitle", productTitle)
            if (!rawIngredients.isNullOrBlank()) put("rawIngredients", rawIngredients)
            put("store", store)
            if (familyWatchlist.isNotEmpty()) {
                put("familyWatchlist", JSONArray(familyWatchlist.toList()))
            }
            put("format", "json")
        }.toString()

        var lastErr = """{"ok":false,"error":"Unable to reach HeyBroc server"}"""
        for (endpoint in ENDPOINTS) {
            try {
                val res = postFollowingRedirects(endpoint, body, maxRedirects = 4)
                if (res.startsWith("{") && (res.contains("\"ok\":true") || res.contains("\"ok\":false") || res.contains("\"result\""))) {
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
