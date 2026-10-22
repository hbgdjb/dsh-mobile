#
# DshNode 的 JNI 包装。
#
# 只编译一个很薄的 .so：把 Java 的 String[] 转成 argv，用 dlopen 加载
# 下载到应用私有目录的 libnode.so，dlsym 取 node::Start 后调用。
#
# 关键：**不链接 libnode.so**，也不需要它的头文件。
# 一旦链接，APK 就必须内置那 117 MB —— 用户根本传不到手机上。
# 改成运行时 dlopen 后，APK 只多这 20 KB。
#
cmake_minimum_required(VERSION 3.18)
project(dshnode CXX)

set(CMAKE_CXX_STANDARD 17)

add_library(dshnode SHARED dshnode.cpp)

# 只需要系统库：dl 用于 dlopen/dlsym，log 用于 __android_log_print
target_link_libraries(dshnode log dl)
