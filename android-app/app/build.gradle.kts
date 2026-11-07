plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val apiBase: String = (project.findProperty("cleancartApiBase") as String?) ?: "https://heybroc.com"

android {
    namespace = "com.cleancart.overlay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cleancart.overlay"
        minSdk = 26
        targetSdk = 36
        versionCode = 10
        versionName = "1.9.0"
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    val keystoreFileEnv = System.getenv("KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    val keystoreBase64Env = System.getenv("KEYSTORE_BASE64")?.takeIf { it.isNotBlank() }
    val keystorePasswordEnv = System.getenv("KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
    val keyAliasEnv = System.getenv("KEY_ALIAS")?.takeIf { it.isNotBlank() }
    val keyPasswordEnv = System.getenv("KEY_PASSWORD")?.takeIf { it.isNotBlank() }

    val resolvedKeystoreFile = when {
        keystoreFileEnv != null && file(keystoreFileEnv).exists() -> file(keystoreFileEnv)
        keystoreBase64Env != null -> {
            val out = layout.buildDirectory.file("tmp/heybroc-release.jks").get().asFile
            out.parentFile.mkdirs()
            out.writeBytes(java.util.Base64.getMimeDecoder().decode(keystoreBase64Env))
            out
        }
        else -> null
    }
    val hasReleaseSigning = resolvedKeystoreFile != null &&
        keystorePasswordEnv != null &&
        keyAliasEnv != null &&
        keyPasswordEnv != null

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = resolvedKeystoreFile
                storePassword = keystorePasswordEnv
                keyAlias = keyAliasEnv
                keyPassword = keyPasswordEnv
            }
        }
    }

    buildFeatures { buildConfig = true }

    lint {
        abortOnError = true
        checkOnly.add("NewApi")
        checkReleaseBuilds = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// No third-party dependencies: plain Android framework views + HttpURLConnection + org.json.
