package com.cleancart.overlay

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hardened HTTPS bitmap loader with SSRF / private-IP / redirect validation,
 * bounded stream buffering (2.5 MB), two-pass BitmapFactory bounds decoding,
 * aspect-ratio-preserving downsampling, negative caching, shared RAM cache,
 * bounded persistent disk cache (OFF & HeyBroc assets only), per-URL in-flight
 * deduplication, and 60s DNS verification caching.
 */
object SafeBitmapLoader {
    private const val MAX_IMAGE_BYTES = 2_621_440 // 2.5 MB
    private const val MAX_SOURCE_DIMENSION_PX = 6000
    private const val MAX_REDIRECTS = 3
    private const val CONNECT_TIMEOUT_MS = 3500
    private const val READ_TIMEOUT_MS = 5000
    private const val NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000L
    private const val MAX_NEGATIVE_CACHE_ENTRIES = 512
    private const val DNS_CACHE_TTL_MS = 60 * 1000L
    private const val MAX_DNS_CACHE_ENTRIES = 256
    private const val DISK_CACHE_DIR_NAME = "heybroc_img_v1"
    private const val DISK_CACHE_MAX_BYTES = 24L * 1024L * 1024L
    private const val DISK_CACHE_PRUNE_TARGET_BYTES = 18L * 1024L * 1024L
    private const val DISK_CACHE_TTL_MS = 7L * 24L * 60L * 60L * 1000L

    private val negativeUrlCache = ConcurrentHashMap<String, Long>()
    private val verifiedHostCache = ConcurrentHashMap<String, Pair<Boolean, Long>>()
    private val inFlightLocks = ConcurrentHashMap<String, Any>()
    private val sharedMemCache = createBitmapLruCache(12 * 1024)
    private val diskWriteCounter = AtomicInteger(0)

    @Volatile
    private var diskCacheDir: File? = null

    fun init(context: Context) {
        if (diskCacheDir != null) return
        runCatching {
            val dir = File(context.applicationContext.cacheDir, DISK_CACHE_DIR_NAME)
            if (!dir.exists()) {
                dir.mkdirs()
            }
            if (dir.isDirectory) {
                diskCacheDir = dir
            }
        }
    }

    fun getCachedMemoryBitmap(rawUrl: String, minDimPx: Int = 0): Bitmap? {
        val clean = sanitizeExternalImageUrl(rawUrl, rejectHeyBroc = false)
        if (clean.isEmpty()) return null
        return memoryHitForSize(clean, minDimPx)
    }

    /**
     * The shared RAM cache is keyed by URL only, so a bitmap decoded for a small list thumbnail
     * must not be reused (and visibly upscaled/blurry) by a larger view. Accept a hit only when its
     * longest side covers at least ~75% of the requested size; otherwise re-decode from disk cache.
     */
    private fun memoryHitForSize(cleanUrl: String, minDimPx: Int): Bitmap? {
        val bmp = sharedMemCache.get(cleanUrl) ?: return null
        if (minDimPx <= 0) return bmp
        val wanted = minDimPx.coerceIn(64, 512)
        return if (maxOf(bmp.width, bmp.height) * 4 >= wanted * 3) bmp else null
    }

    fun createBitmapLruCache(maxKilobytes: Int): LruCache<String, Bitmap> {
        val safeMaxKb = maxKilobytes.coerceAtLeast(1024)
        return object : LruCache<String, Bitmap>(safeMaxKb) {
            override fun sizeOf(key: String, value: Bitmap): Int {
                return (value.allocationByteCount / 1024).coerceAtLeast(1)
            }
        }
    }

    private fun isDiskCacheableUrl(url: String): Boolean {
        val host = runCatching { URI(url).host?.lowercase().orEmpty() }.getOrDefault("")
        if (host.isEmpty()) return false
        return host == "www.heybroc.com" ||
            host == "heybroc.com" ||
            host == "cleancart-teal.vercel.app" ||
            host == "openfoodfacts.org" ||
            host == "openfoodfacts.net" ||
            host.endsWith(".openfoodfacts.org") ||
            host.endsWith(".openfoodfacts.net")
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val hexChars = "0123456789abcdef"
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            sb.append(hexChars[v ushr 4])
            sb.append(hexChars[v and 0x0F])
        }
        return sb.toString()
    }

    private fun diskFileForUrl(url: String): File? {
        val dir = diskCacheDir ?: return null
        if (!isDiskCacheableUrl(url)) return null
        return File(dir, "${sha256Hex(url)}.img")
    }

    private fun readDiskCacheBytes(url: String): ByteArray? {
        val file = diskFileForUrl(url) ?: return null
        return runCatching {
            if (!file.isFile) return@runCatching null
            val ageMs = System.currentTimeMillis() - file.lastModified()
            if (ageMs > DISK_CACHE_TTL_MS || file.length() !in 64L..MAX_IMAGE_BYTES.toLong()) {
                file.delete()
                return@runCatching null
            }
            file.setLastModified(System.currentTimeMillis())
            file.readBytes()
        }.getOrNull()
    }

    private fun writeDiskCacheBytes(url: String, bytes: ByteArray) {
        val file = diskFileForUrl(url) ?: return
        if (bytes.size !in 64..MAX_IMAGE_BYTES) return
        runCatching {
            val parent = file.parentFile ?: return@runCatching
            if (!parent.exists()) parent.mkdirs()
            val tmp = File(parent, "${file.name}.${System.nanoTime()}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) {
                file.writeBytes(bytes)
                tmp.delete()
            }
            if (diskWriteCounter.incrementAndGet() % 24 == 0) {
                pruneDiskCacheIfNeeded(parent)
            }
        }
    }

    private fun pruneDiskCacheIfNeeded(dir: File) {
        runCatching {
            val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".img") } ?: return
            val now = System.currentTimeMillis()
            var totalBytes = 0L
            val live = ArrayList<File>(files.size)
            for (f in files) {
                if (now - f.lastModified() > DISK_CACHE_TTL_MS) {
                    f.delete()
                } else {
                    totalBytes += f.length()
                    live.add(f)
                }
            }
            if (totalBytes <= DISK_CACHE_MAX_BYTES) return
            live.sortBy { it.lastModified() }
            for (f in live) {
                if (totalBytes <= DISK_CACHE_PRUNE_TARGET_BYTES) break
                val len = f.length()
                if (f.delete()) {
                    totalBytes -= len
                }
            }
        }
    }

    private fun isBlockedRedirectOrInternalHost(rawHost: String, rejectHeyBroc: Boolean): Boolean {
        val host = rawHost.trim().trimEnd('.').removePrefix("[").removeSuffix("]").lowercase()
        if (host.isEmpty()) return true
        if (
            host == "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            host.endsWith(".lan") ||
            host.endsWith(".home") ||
            host.endsWith(".arpa")
        ) {
            return true
        }
        if (
            host == "itunes.apple.com" ||
            host == "apps.apple.com" ||
            host == "play.google.com" ||
            host == "bnc.lt" ||
            host == "app.adjust.com" ||
            host == "smart.link" ||
            host.endsWith(".app.link") ||
            host.endsWith(".onelink.me") ||
            host.endsWith(".adj.st") ||
            host.endsWith(".branch.io") ||
            host.endsWith(".smart.link")
        ) {
            return true
        }
        if (rejectHeyBroc && (host.contains("heybroc.com") || host.contains("cleancart"))) {
            return true
        }
        return false
    }

    fun isPublicRoutableAddress(addr: InetAddress): Boolean {
        if (
            addr.isAnyLocalAddress ||
            addr.isLoopbackAddress ||
            addr.isLinkLocalAddress ||
            addr.isSiteLocalAddress ||
            addr.isMulticastAddress
        ) {
            return false
        }
        val bytes = addr.address ?: return false
        if (bytes.size == 4) {
            val b0 = bytes[0].toInt() and 0xFF
            val b1 = bytes[1].toInt() and 0xFF
            return !isPrivateIpv4Octets(b0, b1)
        }
        if (bytes.size == 16) {
            val b0 = bytes[0].toInt() and 0xFF
            val b1 = bytes[1].toInt() and 0xFF
            // Unique Local Address fc00::/7, link-local fe80::/10, multicast ff00::/8
            if ((b0 and 0xFE) == 0xFC) return false
            if (b0 == 0xFE && (b1 and 0xC0) == 0x80) return false
            if (b0 == 0xFF) return false
            // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d)
            val prefixZeros = (0 until 10).all { bytes[it].toInt() == 0 }
            val isV4Mapped = prefixZeros &&
                (bytes[10].toInt() and 0xFF) == 0xFF &&
                (bytes[11].toInt() and 0xFF) == 0xFF
            val isV4Compat = prefixZeros &&
                bytes[10].toInt() == 0 &&
                bytes[11].toInt() == 0
            if (isV4Mapped || isV4Compat) {
                val v4b0 = bytes[12].toInt() and 0xFF
                val v4b1 = bytes[13].toInt() and 0xFF
                if (isPrivateIpv4Octets(v4b0, v4b1)) return false
            }
            return true
        }
        return false
    }

    private fun isPrivateIpv4Octets(b0: Int, b1: Int): Boolean {
        if (b0 == 0 || b0 == 10 || b0 == 127) return true
        if (b0 == 169 && b1 == 254) return true
        if (b0 == 172 && b1 in 16..31) return true
        if (b0 == 192 && b1 == 168) return true
        // Carrier-Grade NAT 100.64.0.0/10
        if (b0 == 100 && b1 in 64..127) return true
        // Benchmarking 198.18.0.0/15 & multicast/reserved 224.0.0.0/3
        if (b0 == 198 && (b1 == 18 || b1 == 19)) return true
        if (b0 >= 224) return true
        return false
    }

    fun sanitizeExternalImageUrl(rawUrl: String?, rejectHeyBroc: Boolean = true): String {
        val trimmed = rawUrl?.trim().orEmpty()
        if (trimmed.length !in 8..900) return ""
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return ""
        if (!uri.scheme.equals("https", ignoreCase = true)) return ""
        if (uri.rawUserInfo != null) return ""
        if (uri.port != -1 && uri.port != 443) return ""
        val rawHost = uri.host ?: return ""
        if (isBlockedRedirectOrInternalHost(rawHost, rejectHeyBroc = rejectHeyBroc)) {
            return ""
        }
        return trimmed
    }

    private fun resolveAndVerifyHost(host: String): Boolean {
        val normalized = host.trim().trimEnd('.').removePrefix("[").removeSuffix("]").lowercase()
        if (normalized.isEmpty()) return false
        val now = System.currentTimeMillis()
        verifiedHostCache[normalized]?.let { (ok, exp) ->
            if (now < exp) return ok
            verifiedHostCache.remove(normalized)
        }
        val addrs = runCatching { InetAddress.getAllByName(normalized) }.getOrNull() ?: return false
        if (addrs.isEmpty()) return false
        val ok = addrs.all { isPublicRoutableAddress(it) }
        if (verifiedHostCache.size >= MAX_DNS_CACHE_ENTRIES) {
            verifiedHostCache.clear()
        }
        verifiedHostCache[normalized] = Pair(ok, now + DNS_CACHE_TTL_MS)
        return ok
    }

    private fun isNegativelyCached(url: String): Boolean {
        val exp = negativeUrlCache[url] ?: return false
        if (System.currentTimeMillis() < exp) return true
        negativeUrlCache.remove(url)
        return false
    }

    private fun recordNegativeCache(url: String) {
        if (negativeUrlCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
            val now = System.currentTimeMillis()
            val iter = negativeUrlCache.entries.iterator()
            while (iter.hasNext()) {
                if (iter.next().value <= now) iter.remove()
            }
            if (negativeUrlCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
                negativeUrlCache.clear()
            }
        }
        negativeUrlCache[url] = System.currentTimeMillis() + NEGATIVE_CACHE_TTL_MS
    }

    private fun decodeScaledBytes(bytes: ByteArray, targetMax: Int): Bitmap? {
        if (bytes.size < 64) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (
            bounds.outWidth !in 16..MAX_SOURCE_DIMENSION_PX ||
            bounds.outHeight !in 16..MAX_SOURCE_DIMENSION_PX
        ) {
            return null
        }

        var sampleSize = 1
        while (
            (bounds.outWidth / (sampleSize * 2)) >= targetMax &&
            (bounds.outHeight / (sampleSize * 2)) >= targetMax
        ) {
            sampleSize *= 2
        }

        val decodeOpts = BitmapFactory.Options().apply {
            inJustDecodeBounds = false
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts)
        if (decoded == null || decoded.width < 16 || decoded.height < 16) {
            return null
        }

        if (decoded.width <= targetMax && decoded.height <= targetMax) {
            return decoded
        }

        val ratio = minOf(
            targetMax.toFloat() / decoded.width.coerceAtLeast(1),
            targetMax.toFloat() / decoded.height.coerceAtLeast(1)
        )
        val scaledW = (decoded.width * ratio).toInt().coerceAtLeast(1)
        val scaledH = (decoded.height * ratio).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(decoded, scaledW, scaledH, true)
        if (scaled !== decoded) {
            decoded.recycle()
        }
        return scaled
    }

    fun fetchScaledBitmap(rawUrl: String, maxDimPx: Int): Bitmap? {
        val startUrl = sanitizeExternalImageUrl(rawUrl, rejectHeyBroc = false)
        if (startUrl.isEmpty()) return null

        memoryHitForSize(startUrl, maxDimPx)?.let { return it }

        val targetMax = maxDimPx.coerceIn(64, 512)
        readDiskCacheBytes(startUrl)?.let { cachedBytes ->
            val fromDisk = decodeScaledBytes(cachedBytes, targetMax)
            if (fromDisk != null) {
                sharedMemCache.put(startUrl, fromDisk)
                return fromDisk
            }
            diskFileForUrl(startUrl)?.delete()
        }
        // Disk cache couldn't supply a larger decode — a smaller RAM bitmap beats a re-download.
        sharedMemCache.get(startUrl)?.let { return it }

        if (isNegativelyCached(startUrl)) return null

        val lock = inFlightLocks.computeIfAbsent(startUrl) { Any() }
        try {
            synchronized(lock) {
                memoryHitForSize(startUrl, maxDimPx)?.let { return it }
                readDiskCacheBytes(startUrl)?.let { cachedBytes ->
                    val fromDisk = decodeScaledBytes(cachedBytes, targetMax)
                    if (fromDisk != null) {
                        sharedMemCache.put(startUrl, fromDisk)
                        return fromDisk
                    }
                    diskFileForUrl(startUrl)?.delete()
                }
                sharedMemCache.get(startUrl)?.let { return it }
                if (isNegativelyCached(startUrl)) return null

                var currentUrlStr = startUrl
                for (hop in 0..MAX_REDIRECTS) {
                    val validatedHop = sanitizeExternalImageUrl(currentUrlStr, rejectHeyBroc = false)
                    if (validatedHop.isEmpty()) return null
                    val parsedUrl = runCatching { URL(validatedHop) }.getOrNull() ?: return null
                    if (!resolveAndVerifyHost(parsedUrl.host)) {
                        recordNegativeCache(startUrl)
                        return null
                    }

                    val conn = (runCatching { parsedUrl.openConnection() as? HttpURLConnection }.getOrNull())
                        ?: return null
                    conn.instanceFollowRedirects = false
                    conn.connectTimeout = CONNECT_TIMEOUT_MS
                    conn.readTimeout = READ_TIMEOUT_MS
                    conn.setRequestProperty("User-Agent", "HeyBroc-Android/2.5.10")
                    conn.setRequestProperty("Accept", "image/webp,image/png,image/jpeg,image/*;q=0.8")

                    try {
                        val status = runCatching { conn.responseCode }.getOrDefault(-1)
                        if (status in intArrayOf(301, 302, 303, 307, 308)) {
                            if (hop == MAX_REDIRECTS) return null
                            val loc = conn.getHeaderField("Location")?.trim().orEmpty()
                            if (loc.isEmpty()) return null
                            val nextUrl = runCatching { URL(parsedUrl, loc).toString() }.getOrNull() ?: return null
                            currentUrlStr = nextUrl
                            continue
                        }

                        if (status == 404 || status == 410) {
                            if (conn.getHeaderField("X-Image-Retry") != "1") {
                                recordNegativeCache(startUrl)
                            }
                            return null
                        }
                        if (status !in 200..299) {
                            return null
                        }

                        val declaredLength = conn.contentLengthLong
                        if (declaredLength > MAX_IMAGE_BYTES) {
                            recordNegativeCache(startUrl)
                            return null
                        }

                        val contentType = conn.contentType?.lowercase().orEmpty()
                        if (
                            contentType.isNotEmpty() &&
                            (!contentType.startsWith("image/") ||
                                contentType.contains("svg") ||
                                contentType.contains("html") ||
                                contentType.contains("xml"))
                        ) {
                            recordNegativeCache(startUrl)
                            return null
                        }

                        val bytes = runCatching {
                            conn.inputStream.use { input ->
                                val out = ByteArrayOutputStream(
                                    if (declaredLength in 128..MAX_IMAGE_BYTES.toLong()) declaredLength.toInt() else 16_384
                                )
                                val buf = ByteArray(8192)
                                var total = 0
                                while (true) {
                                    val read = input.read(buf)
                                    if (read <= 0) break
                                    total += read
                                    if (total > MAX_IMAGE_BYTES) {
                                        return@use null
                                    }
                                    out.write(buf, 0, read)
                                }
                                out.toByteArray()
                            }
                        }.getOrNull()

                        if (bytes == null || bytes.size < 64) {
                            if (bytes == null) recordNegativeCache(startUrl)
                            return null
                        }

                        val decoded = decodeScaledBytes(bytes, targetMax)
                        if (decoded == null) {
                            recordNegativeCache(startUrl)
                            return null
                        }

                        sharedMemCache.put(startUrl, decoded)
                        writeDiskCacheBytes(startUrl, bytes)
                        return decoded
                    } finally {
                        conn.disconnect()
                    }
                }
                return null
            }
        } finally {
            inFlightLocks.remove(startUrl, lock)
        }
    }
}
