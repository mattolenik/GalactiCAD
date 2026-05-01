# Microsoft Developer Studio Project File - Name="libasc" - Package Owner=<4>
# Microsoft Developer Studio Generated Build File, Format Version 6.00
# ** DO NOT EDIT **

# TARGTYPE "Win32 (x86) Static Library" 0x0104

CFG=libasc - Win32 libasc8
!MESSAGE This is not a valid makefile. To build this project using NMAKE,
!MESSAGE use the Export Makefile command and run
!MESSAGE 
!MESSAGE NMAKE /f "libasc.mak".
!MESSAGE 
!MESSAGE You can specify a configuration when running NMAKE
!MESSAGE by defining the macro CFG on the command line. For example:
!MESSAGE 
!MESSAGE NMAKE /f "libasc.mak" CFG="libasc - Win32 libasc8"
!MESSAGE 
!MESSAGE Possible choices for configuration are:
!MESSAGE 
!MESSAGE "libasc - Win32 libasc1" (based on "Win32 (x86) Static Library")
!MESSAGE "libasc - Win32 libasc2" (based on "Win32 (x86) Static Library")
!MESSAGE "libasc - Win32 libasc4" (based on "Win32 (x86) Static Library")
!MESSAGE "libasc - Win32 libasc8" (based on "Win32 (x86) Static Library")
!MESSAGE 

# Begin Project
# PROP AllowPerConfigDependencies 0
# PROP Scc_ProjName ""
# PROP Scc_LocalPath ""
CPP=cl.exe
RSC=rc.exe

!IF  "$(CFG)" == "libasc - Win32 libasc1"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 1
# PROP BASE Output_Dir "libasc___Win32_libasc1"
# PROP BASE Intermediate_Dir "libasc___Win32_libasc1"
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 1
# PROP Output_Dir "../bin"
# PROP Intermediate_Dir "libasc1"
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /YX /FD /GZ /c
# ADD CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER1" /YX /FD /GZ /c
# ADD BASE RSC /l 0x409 /d "_DEBUG"
# ADD RSC /l 0x409 /d "_DEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LIB32=link.exe -lib
# ADD BASE LIB32 /nologo
# ADD LIB32 /nologo /out:"..\lib\asc1.lib"

!ELSEIF  "$(CFG)" == "libasc - Win32 libasc2"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 1
# PROP BASE Output_Dir "libasc___Win32_libasc2"
# PROP BASE Intermediate_Dir "libasc___Win32_libasc2"
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 1
# PROP Output_Dir "libasc___Win32_libasc2"
# PROP Intermediate_Dir "libasc___Win32_libasc2"
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER1" /YX /FD /GZ /c
# ADD CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER2" /YX /FD /GZ /c
# ADD BASE RSC /l 0x409 /d "_DEBUG"
# ADD RSC /l 0x409 /d "_DEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LIB32=link.exe -lib
# ADD BASE LIB32 /nologo /out:"..\lib\asc1.lib"
# ADD LIB32 /nologo /out:"..\lib\asc2.lib"

!ELSEIF  "$(CFG)" == "libasc - Win32 libasc4"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 1
# PROP BASE Output_Dir "libasc___Win32_libasc4"
# PROP BASE Intermediate_Dir "libasc___Win32_libasc4"
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 1
# PROP Output_Dir "libasc___Win32_libasc4"
# PROP Intermediate_Dir "libasc___Win32_libasc4"
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER2" /YX /FD /GZ /c
# ADD CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER4" /YX /FD /GZ /c
# ADD BASE RSC /l 0x409 /d "_DEBUG"
# ADD RSC /l 0x409 /d "_DEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LIB32=link.exe -lib
# ADD BASE LIB32 /nologo /out:"..\lib\asc2.lib"
# ADD LIB32 /nologo /out:"..\lib\asc4.lib"

!ELSEIF  "$(CFG)" == "libasc - Win32 libasc8"

# PROP BASE Use_MFC 0
# PROP BASE Use_Debug_Libraries 1
# PROP BASE Output_Dir "libasc___Win32_libasc8"
# PROP BASE Intermediate_Dir "libasc___Win32_libasc8"
# PROP BASE Target_Dir ""
# PROP Use_MFC 0
# PROP Use_Debug_Libraries 1
# PROP Output_Dir "libasc___Win32_libasc8"
# PROP Intermediate_Dir "libasc___Win32_libasc8"
# PROP Target_Dir ""
# ADD BASE CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER4" /YX /FD /GZ /c
# ADD CPP /nologo /W3 /Gm /GX /ZI /Od /D "WIN32" /D "_DEBUG" /D "_MBCS" /D "_LIB" /D "ASCHEADER8" /YX /FD /GZ /c
# ADD BASE RSC /l 0x409 /d "_DEBUG"
# ADD RSC /l 0x409 /d "_DEBUG"
BSC32=bscmake.exe
# ADD BASE BSC32 /nologo
# ADD BSC32 /nologo
LIB32=link.exe -lib
# ADD BASE LIB32 /nologo /out:"..\lib\asc4.lib"
# ADD LIB32 /nologo /out:"..\lib\asc8.lib"

!ENDIF 

# Begin Target

# Name "libasc - Win32 libasc1"
# Name "libasc - Win32 libasc2"
# Name "libasc - Win32 libasc4"
# Name "libasc - Win32 libasc8"
# Begin Group "Source Files"

# PROP Default_Filter "cpp;c;cxx;rc;def;r;odl;idl;hpj;bat"
# Begin Source File

SOURCE=.\asc.cpp
# End Source File
# Begin Source File

SOURCE=.\block.cpp
# End Source File
# Begin Source File

SOURCE=.\common.cpp
# End Source File
# Begin Source File

SOURCE=.\data.cpp
# End Source File
# Begin Source File

SOURCE=.\dikelign.cpp
# End Source File
# Begin Source File

SOURCE=.\doublist.cpp
# End Source File
# Begin Source File

SOURCE=.\farm.cpp
# End Source File
# Begin Source File

SOURCE=.\highrice.cpp
# End Source File
# Begin Source File

SOURCE=.\index.cpp
# End Source File
# Begin Source File

SOURCE=.\initdata.cpp
# End Source File
# Begin Source File

SOURCE=.\interface.cpp
# End Source File
# Begin Source File

SOURCE=.\kdtree.cpp
# End Source File
# Begin Source File

SOURCE=.\misc.cpp
# End Source File
# Begin Source File

SOURCE=.\padi.cpp
# End Source File
# Begin Source File

SOURCE=.\slab.cpp
# End Source File
# Begin Source File

SOURCE=.\strip.cpp
# End Source File
# Begin Source File

SOURCE=.\trackball.cpp
# End Source File
# Begin Source File

SOURCE=.\vecmath.cpp
# End Source File
# End Group
# Begin Group "Header Files"

# PROP Default_Filter "h;hpp;hxx;hm;inl"
# Begin Source File

SOURCE=.\asc.h
# End Source File
# Begin Source File

SOURCE=.\block.h
# End Source File
# Begin Source File

SOURCE=.\common.h
# End Source File
# Begin Source File

SOURCE=.\data.h
# End Source File
# Begin Source File

SOURCE=.\datatype.h
# End Source File
# Begin Source File

SOURCE=.\dikelign.h
# End Source File
# Begin Source File

SOURCE=.\doublist.h
# End Source File
# Begin Source File

SOURCE=.\farm.h
# End Source File
# Begin Source File

SOURCE=.\global.h
# End Source File
# Begin Source File

SOURCE=.\highrice.h
# End Source File
# Begin Source File

SOURCE=.\index.h
# End Source File
# Begin Source File

SOURCE=.\initdata.h
# End Source File
# Begin Source File

SOURCE=.\interface.h
# End Source File
# Begin Source File

SOURCE=.\kdtree.h
# End Source File
# Begin Source File

SOURCE=.\misc.h
# End Source File
# Begin Source File

SOURCE=.\padi.h
# End Source File
# Begin Source File

SOURCE=.\pcvalues.h
# End Source File
# Begin Source File

SOURCE=.\slab.h
# End Source File
# Begin Source File

SOURCE=.\strip.h
# End Source File
# Begin Source File

SOURCE=.\trackball.h
# End Source File
# Begin Source File

SOURCE=.\vecmath.h
# End Source File
# Begin Source File

SOURCE=.\vortex.h
# End Source File
# End Group
# End Target
# End Project
