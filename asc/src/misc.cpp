
#ifndef WIN32
#include <sys/time.h>
/* #include <sys/rusage.h> */
#include <sys/resource.h>
#endif
#include "misc.h"



void GetCpuTime(float *usertime, float *systime)
{
#ifndef WIN32
  struct rusage usage;
  getrusage(RUSAGE_SELF, &usage);
  *usertime = (float)usage.ru_utime.tv_sec + (float)usage.ru_utime.tv_usec / 1000000.;
  *systime  = (float)usage.ru_stime.tv_sec + (float)usage.ru_stime.tv_usec / 1000000.;
#endif
}

