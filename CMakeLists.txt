cmake_minimum_required(VERSION 3.14)
project(voice-drawing-backend VERSION 0.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC 编码
if(MSVC)
    add_compile_options(/utf-8 /D_CRT_SECURE_NO_WARNINGS)
endif()

# ============================================================
# OpenSSL (httplib HTTPS + 讯飞鉴权 HMAC-SHA256)
# ============================================================
find_package(OpenSSL REQUIRED)

# ============================================================
# libcurl (星火 Lite API HTTPS 请求)
# ============================================================
find_package(CURL REQUIRED)

# ============================================================
# 本地 header-only 库
# ============================================================
add_library(httplib INTERFACE)
target_include_directories(httplib INTERFACE ${CMAKE_SOURCE_DIR}/include)
target_compile_definitions(httplib INTERFACE CPPHTTPLIB_OPENSSL_SUPPORT)

add_library(nlohmann_json INTERFACE)
target_include_directories(nlohmann_json INTERFACE ${CMAKE_SOURCE_DIR}/include)

# ============================================================
# ixwebsocket (本地源码 ixwebsocket_src/)
# ============================================================
set(USE_TLS ON CACHE BOOL "" FORCE)
add_subdirectory(ixwebsocket_src)

# ============================================================
# 可执行文件
# ============================================================
add_executable(server
    src/server.cpp
    src/speech_recognizer.cpp
    src/spark_client.cpp
)

target_include_directories(server PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/ixwebsocket_src/ixwebsocket
)

target_link_libraries(server PRIVATE
    httplib
    nlohmann_json
    ixwebsocket
    OpenSSL::SSL
    OpenSSL::Crypto
    CURL::libcurl
)

if(WIN32)
    target_link_libraries(server PRIVATE ws2_32)
endif()
